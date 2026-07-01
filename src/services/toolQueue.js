const Listing = require('../models/Listing');
const Photo = require('../models/Photo');
const ToolJob = require('../models/ToolJob');
const UsageEvent = require('../models/UsageEvent');
const Notification = require('../models/Notification');
const {
  runMultiImageReview,
  runContentReview,
  runFloorPlanReview,
  runFurnishingSuggestion,
  runListingCopy,
} = require('./geminiTaskService');
const { runGeminiImageEdit } = require('./geminiImageService');

// Run up to this many tool jobs (staging, enhancement, custom edits, etc.) concurrently.
// Previously this queue processed strictly one job at a time, globally, across every
// listing and every user — a single slow Gemini image generation (the heaviest call)
// would block every other photo's "AI generating…" spinner, every accept, and every
// other listing's jobs behind it in line. That's the main reason generation, accept,
// and switching between photos with pending jobs could feel like it took "too much
// time" — it wasn't slow, it was queued behind unrelated work.
const CONCURRENCY = parseInt(process.env.TOOL_QUEUE_CONCURRENCY || '4', 10);

const queue = [];
const queuedIds = new Set();
let processing = false;

async function enqueueToolJobs(ids) {
  for (const id of ids.map(String)) {
    if (queuedIds.has(id)) continue;
    queuedIds.add(id);
    queue.push(id);
  }
  // Fire-and-forget: kick off processing but return immediately so the HTTP
  // response (202 Accepted) is sent before Gemini starts working.
  processQueue().catch((err) => console.error('[tool-queue] processQueue error:', err));
}

async function runJob(job) {
  const listing = await Listing.findById(job.listing).lean();
  if (!listing) throw new Error('Listing no longer exists');
  const photos = await Photo.find({ listing: listing._id }).lean();
  const photo = job.photo ? photos.find((item) => String(item._id) === String(job.photo)) : null;

  switch (job.tool) {
    case 'multi_image_analysis':
      return { resultType: 'report', resultData: await runMultiImageReview(listing, photos) };
    case 'content_moderation':
      if (!photo) throw new Error('The source photo no longer exists');
      return { resultType: 'report', resultData: await runContentReview(photo) };
    case 'floor_plan_recognition':
      if (!photo) throw new Error('Choose a floor-plan image before starting recognition');
      return { resultType: 'report', resultData: await runFloorPlanReview(photo) };
    case 'virtual_staging': {
      if (!photo) throw new Error('Choose an empty-room photo before requesting furnishing suggestions');
      // Extract structured fields from the prompt built by the frontend.
      // Format: "Room: X. Preferred colors: A, B. Current plan - ...; Furniture: .... Changes requested: ..."
      const userPreferences = {};
      if (job.prompt) {
        const roomMatch    = /Room:\s*([^.]+)/i.exec(job.prompt);
        if (roomMatch) userPreferences.roomType = roomMatch[1].trim();

        const colorMatch   = /Preferred colors:\s*([^.]+)/i.exec(job.prompt);
        if (colorMatch) userPreferences.colorPalette = colorMatch[1].split(/,\s*/).map(s => s.trim()).filter(Boolean);

        // Style chosen in the furniture picker (e.g. "modern", "scandinavian")
        const styleMatch   = /Style:\s*([^.]+)/i.exec(job.prompt);
        if (styleMatch) userPreferences.style = styleMatch[1].trim();

        // Furniture pieces the user tapped/selected in the icon picker —
        // these MUST end up in the generated plan, not be replaced by Gemini's own picks.
        const furnitureMatch = /Furniture:\s*([^.]+?)(?:\.\s*(?:Changes requested|Current plan|Variation)\s*[:\-]|$)/is.exec(job.prompt);
        if (furnitureMatch) {
          userPreferences.furniture = furnitureMatch[1].split(/,\s*/).map(s => s.trim()).filter(Boolean);
        }

        // User's freeform edit instructions — tell Gemini exactly what to change
        const instrMatch   = /Changes requested:\s*(.+)/i.exec(job.prompt);
        if (instrMatch) userPreferences.customInstructions = instrMatch[1].trim().replace(/\.$/, '');

        // Existing plan context so Gemini modifies rather than generates from scratch
        const planMatch    = /Current plan\s*[-:]\s*(.+?)(?:\.\s*Changes requested:|$)/is.exec(job.prompt);
        if (planMatch) userPreferences.existingPlanContext = planMatch[1].trim();

        // Variation flag — user dismissed the previous plan and wants something fresh
        if (/Variation:\s*true/i.test(job.prompt)) userPreferences.requestVariation = true;
      }
      const suggestion = await runFurnishingSuggestion(photo, null, userPreferences);
      // Persist onto the Photo document itself, not just this job's resultData,
      // so the suggestion has its own accept/dismiss lifecycle independent of
      // this one-off job record (mirrors how confirmedFloorPlan works).
      const livePhoto = await Photo.findById(photo._id);
      if (livePhoto) {
        livePhoto.furnishingSuggestion = {
          roomType: userPreferences.roomType || suggestion.roomType || photo.analysis?.roomType || null,
          roomSubtype: suggestion.roomSubtype || livePhoto.roomSubtype || null,
          estimatedDimensions: suggestion.estimatedDimensions || {},
          style: suggestion.style || userPreferences.style || '',
          colorPalette: Array.isArray(suggestion.colorPalette) ? suggestion.colorPalette.slice(0, 4) : [],
          lightingMood: suggestion.lightingMood || '',
          pieces: Array.isArray(suggestion.pieces) ? suggestion.pieces.slice(0, 24) : [], // raised from 16 for headroom above the largest room's item count plus extras
          lighting: Array.isArray(suggestion.lighting) ? suggestion.lighting.slice(0, 8) : [],
          windowTreatments: suggestion.windowTreatments || {},
          bedding: suggestion.bedding || {},
          summary: suggestion.summary || '',
          generatedAt: new Date(),
          status: 'suggested',
        };
        await livePhoto.save();
      }
      return { resultType: 'report', resultData: suggestion };
    }
    case 'listing_copy':
      return { resultType: 'text', resultData: await runListingCopy(listing, photos) };
    case 'photo_enhancement':
    case 'defurnishing':
    case 'smart_editing':
    case 'custom_edit':
    case 'virtual_staging_render': {
      if (!photo) throw new Error('The source photo no longer exists');
      const result = await runGeminiImageEdit(job, photo);
      return {
        resultType: 'image',
        resultUrl: result.url,
        resultVersion: result.version._id,
        resultData: { summary: 'A new image version is ready for comparison with the original.' },
      };
    }
    default:
      throw new Error('This image-editing job requires a configured specialist provider');
  }
}

async function runOneJob(id) {
  const job = await ToolJob.findById(id);
  if (!job || job.status !== 'queued') return;
  try {
    job.status = 'processing';
    job.startedAt = new Date();
    job.errorMessage = null;
    job.message = 'Zenrth is processing this task.';
    await job.save();
    const result = await runJob(job);
    job.status = 'ready_for_review';
    job.resultType = result.resultType;
    job.resultData = result.resultData;
    job.resultUrl = result.resultUrl || null;
    job.resultVersion = result.resultVersion || null;
    job.completedAt = new Date();
    job.message = 'Review the result and accept it when you are happy.';
  } catch (error) {
    job.status = 'failed';
    job.errorMessage = error.message;
    job.message = error.message;
    job.completedAt = new Date();
  }
  await job.save();
  await UsageEvent.updateOne(
    { listing: job.listing, tool: job.tool, status: 'reserved' },
    { status: job.status === 'failed' ? 'failed' : 'completed' },
    { sort: { createdAt: -1 } }
  );
  const listing = await Listing.findById(job.listing).select('owner title').lean();
  if (listing?.owner) {
    await Notification.create({
      user: listing.owner,
      listing: listing._id,
      type: job.status === 'failed' ? 'tool_failed' : 'tool_ready',
      title: job.status === 'failed' ? 'A property task needs attention' : 'A property result is ready',
      message:
        job.status === 'failed'
          ? `${job.tool.replaceAll('_', ' ')} failed for ${listing.title}.`
          : `${job.tool.replaceAll('_', ' ')} is ready to review for ${listing.title}.`,
    });
  }
}

async function processQueue() {
  if (processing) return;
  processing = true;
  while (queue.length > 0) {
    // Pull a batch and run all jobs in it concurrently, same pattern as photoQueue.js.
    const batch = queue.splice(0, CONCURRENCY);
    for (const id of batch) queuedIds.delete(id);
    await Promise.all(
      batch.map((id) => runOneJob(id).catch((err) => console.error('[tool-queue] job error:', id, err)))
    );
  }
  processing = false;
}

async function resumeQueuedToolJobs() {
  const jobs = await ToolJob.find({ status: { $in: ['queued', 'processing'] } }).select('_id').lean();
  await ToolJob.updateMany({ status: 'processing' }, { status: 'queued' });
  await enqueueToolJobs(jobs.map((job) => job._id));
}

function getToolQueueStatus() {
  return { waiting: queue.length, processing };
}

module.exports = { enqueueToolJobs, resumeQueuedToolJobs, getToolQueueStatus };