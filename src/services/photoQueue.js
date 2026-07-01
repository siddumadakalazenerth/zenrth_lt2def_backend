const Photo = require('../models/Photo');
const Listing = require('../models/Listing');
const { runAnalysisForPhoto, updatePhotoRanking } = require('./analysisService');
const { refreshPropertyAssessment } = require('./propertyAssessmentService');

// Analyse up to this many photos concurrently to stay within Gemini rate limits.
const CONCURRENCY = parseInt(process.env.PHOTO_QUEUE_CONCURRENCY || '3', 10);

const queue = [];
const queuedIds = new Set();
let processing = false;

async function enqueuePhotos(photoIds, { background = false } = {}) {
  for (const photoId of photoIds.map(String)) {
    if (queuedIds.has(photoId)) continue;
    queuedIds.add(photoId);
    queue.push(photoId);
  }
  if (background) {
    // Fire-and-forget: return immediately so the HTTP response isn't blocked.
    processQueue().catch((err) => console.error('[photo-queue] processQueue error:', err));
  } else {
    // Awaited on upload so analysis finishes before the serverless function freezes.
    await processQueue();
  }
}

async function processQueue() {
  if (processing) return;
  processing = true;

  while (queue.length > 0) {
    // Pull a batch and analyse all photos in it concurrently.
    const batch = queue.splice(0, CONCURRENCY);
    for (const id of batch) queuedIds.delete(id);

    const affectedListings = new Set();
    await Promise.all(
      batch.map(async (photoId) => {
        try {
          const photo = await Photo.findById(photoId);
          if (!photo) return;
          await runAnalysisForPhoto(photo);
          affectedListings.add(String(photo.listing));
        } catch (error) {
          console.error(`[photo-queue] failed for ${photoId}:`, error.message);
        }
      })
    );

    // Update ranking and assessment once per affected listing rather than after every photo.
    await Promise.all(
      [...affectedListings].map(async (listingId) => {
        try {
          await updatePhotoRanking(listingId);
          const [listing, photos] = await Promise.all([
            Listing.findById(listingId).lean(),
            Photo.find({ listing: listingId }).lean(),
          ]);
          if (listing) await refreshPropertyAssessment(listing, photos);
        } catch (error) {
          console.error(`[photo-queue] post-analysis failed for listing ${listingId}:`, error.message);
        }
      })
    );
  }

  processing = false;
}

async function resumePendingPhotos() {
  const pending = await Photo.find({ status: 'pending' }).sort({ createdAt: 1 }).select('_id').lean();
  await enqueuePhotos(pending.map((photo) => photo._id));
}

function getQueueStatus() {
  return {
    waiting: queue.length,
    processing,
  };
}

module.exports = { enqueuePhotos, resumePendingPhotos, getQueueStatus };
