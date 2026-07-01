const Photo = require('../models/Photo');
const ToolJob = require('../models/ToolJob');
const AssetVersion = require('../models/AssetVersion');
const { enqueueToolJobs } = require('./toolQueue');
const { reserveUsage } = require('./operationsService');
const { DEFAULT_USER } = require('../middleware/auth');

const DEFAULT_PROMPTS = {
  multi_image_analysis:
    'Review the property photo set for duplicate views, room consistency, missing context, gallery order, and best cover image.',
  floor_plan_recognition:
    'Extract visible room labels and relationships. Do not invent measurements or structural details.',
  virtual_staging:
    'Estimate room dimensions from visible reference objects and suggest furniture pieces that suit the space.',
  listing_copy:
    'Prepare accurate property copy using only confirmed listing details and analyzed visual evidence.',
  content_moderation:
    'Review for people, private information, number plates, documents, watermarks, unsafe content, and misleading edits.',
};

const GEMINI_SUPPORTED_TOOLS = [
  'photo_enhancement',
  'defurnishing',
  'smart_editing',
  'multi_image_analysis',
  'content_moderation',
  'floor_plan_recognition',
  'virtual_staging',
  'virtual_staging_render',
  'listing_copy',
  'custom_edit',
];

const IMAGE_EDIT_TOOLS = ['photo_enhancement', 'defurnishing', 'smart_editing', 'custom_edit', 'virtual_staging_render'];

async function createToolJob({ listing, action, prompt, sourceVersionId }) {
  const existing = await ToolJob.findOne({
    listing: listing._id,
    actionId: action.actionId,
    status: { $in: ['queued', 'processing', 'ready_for_review'] },
  }).sort({ createdAt: -1 });
  if (existing) return existing;

  const photo = action.photoId ? await Photo.findOne({ _id: action.photoId, listing: listing._id }) : null;
  if (action.tool === 'custom_edit' && !String(prompt || '').trim()) {
    throw new Error('Describe the change you want before applying it.');
  }
  await reserveUsage(DEFAULT_USER, listing._id, action.tool);
  const geminiSupported = GEMINI_SUPPORTED_TOOLS.includes(action.tool);
  const status = geminiSupported ? 'queued' : 'failed';
  const message = geminiSupported
    ? 'The task has been added to the Gemini workflow.'
    : 'This tool is not supported.';
  const isImageEdit = IMAGE_EDIT_TOOLS.includes(action.tool);
  const photoIssues = photo?.analysis?.issues || [];
  const obstructionIssue = action.primaryIssue || photoIssues.find((i) => /obstruct|foreground/i.test(i));
  const obstructionFallback =
    action.tool === 'smart_editing' && obstructionIssue
      ? `Remove the foreground obstruction (${obstructionIssue}) from the image. Blend the revealed area naturally with the existing background. Do not add, invent, or enlarge any property features.`
      : null;
  const derivedEditPrompt =
    prompt ||
    photo?.analysis?.recommendation?.editPrompt ||
    obstructionFallback ||
    (isImageEdit && photoIssues.length
      ? `Fix the following issues: ${photoIssues.join(', ')}. Preserve all structural elements, walls, windows, doors, flooring, and fixed fittings exactly as they are.`
      : '');
  if (isImageEdit && !derivedEditPrompt) {
    throw new Error('Re-run Gemini analysis to generate an image-specific editing plan first.');
  }

  if (photo) {
    // $setOnInsert means: only write these fields if this is a brand-new insert.
    // If the record already exists we leave it untouched so the true original is
    // never overwritten after the user accepts a first edit and requests a second.
    await AssetVersion.updateOne(
      { photo: photo._id, kind: 'original' },
      {
        $setOnInsert: {
          listing: listing._id,
          photo: photo._id,
          kind: 'original',
          url: photo.url,
          data: photo.data,
          mimeType: photo.mimeType,
          sizeBytes: photo.sizeBytes,
          selected: true,
        },
      },
      { upsert: true }
    );
  }

  const job = await ToolJob.create({
    listing: listing._id,
    photo: photo?._id || null,
    actionId: action.actionId,
    tool: action.tool,
    status,
    prompt: String(derivedEditPrompt || DEFAULT_PROMPTS[action.tool] || '').slice(0, 4000),
    provider: 'gemini',
    sourceUrl: photo?.url || null,
    message,
    metadata: {
      roomType: action.roomType || null,
      reasonCodes: action.reasonCodes || [],
      geminiConfidence: photo?.analysis?.recommendation?.confidence ?? null,
      preserve: photo?.analysis?.recommendation?.preserve || [],
      preserveOriginal: true,
      requiresUserApproval: true,
      ...(sourceVersionId ? { sourceVersionId: String(sourceVersionId) } : {}),
    },
  });
  if (status === 'queued') await enqueueToolJobs([job._id]);
  return job;
}

function publicToolJob(job) {
  return {
    _id: job._id,
    tool: job.tool,
    status: job.status,
    sourceUrl: job.sourceUrl,
    resultUrl: job.resultUrl,
    resultType: job.resultType,
    resultData: job.resultData,
    message: job.message,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    updatedAt: job.updatedAt,
  };
}

function syntheticActionId(key, photoId) {
  return [key, photoId].join(':').replace(/\s+/g, '-').toLowerCase();
}

/**
 * Scenario 4/6: the seller clicks (or hovers) on any photo and types what they want
 * changed. Same truthful-edit guardrails as the Gemini-recommended actions, just with
 * a user-authored prompt instead of one Gemini derived from analysis.
 */
async function createCustomEditJob({ listing, photo, prompt, sourceVersionId, priorPrompt }) {
  // When editing a specific prior generation (e.g. "change the bedsheet color" on a
  // staged-but-not-yet-accepted image), build a minimal-diff instruction that's
  // grounded in what was actually generated, instead of replacing the whole prompt.
  const finalPrompt = sourceVersionId
    ? `${priorPrompt ? `This image was generated from the following staging instructions:\n${priorPrompt}\n\n` : ''}Now make ONLY this additional change to the image above: ${prompt}`
    : prompt;
  return createToolJob({
    listing,
    action: {
      actionId: syntheticActionId('custom-edit', photo._id) + ':' + Date.now(),
      tool: 'custom_edit',
      photoId: photo._id,
      roomType: photo.analysis?.roomType || null,
      reasonCodes: ['user_prompt'],
    },
    prompt: finalPrompt,
    sourceVersionId,
  });
}

async function createVirtualStagingJob({ listing, photo, prompt }) {
  return createToolJob({
    listing,
    action: {
      actionId: syntheticActionId('virtual-staging', photo._id) + ':' + Date.now(),
      tool: 'virtual_staging',
      photoId: photo._id,
      roomType: photo.analysis?.roomType || null,
      reasonCodes: ['user_request'],
    },
    prompt,
  });
}

const ENHANCEMENT_PROMPT =
  'Professionally enhance this real estate photograph for a property listing.\n' +
  '1. Exposure & HDR: Balance interior and exterior light — lift shadows and dark areas, preserve highlight detail in windows. The room should feel naturally bright, not artificially lit.\n' +
  '2. White balance: Correct colour temperature for accurate, neutral colours true to the actual space. Remove yellow casts from artificial lighting and blue casts from shade.\n' +
  '3. Clarity & sharpness: Increase detail and micro-contrast on surfaces — walls, floors, ceilings, woodwork, tiles, fabrics. Edges should be crisp.\n' +
  '4. Colour vibrancy: Boost saturation subtly so colours are vivid and inviting but still realistic. Do not oversaturate.\n' +
  '5. Noise reduction: Remove grain and digital noise, especially in dark areas.\n' +
  '6. Exterior photos: Enhance sky colour and landscaping naturally. Make greenery vivid and the building facade clean and well-defined.\n' +
  'The result must look like it was captured by a professional real estate photographer — realistic, clean, and true to the original space.';

async function createEnhancementJob({ listing, photo }) {
  return createToolJob({
    listing,
    action: {
      actionId: syntheticActionId('enhance', photo._id) + ':' + Date.now(),
      tool: 'photo_enhancement',
      photoId: photo._id,
      roomType: photo.analysis?.roomType || null,
      reasonCodes: ['user_request'],
    },
    prompt: ENHANCEMENT_PROMPT,
  });
}

const DEFURNISHING_PROMPT =
  'You are a professional real estate photo editor. Your task is to digitally remove ALL moveable furniture and objects from this room photograph, leaving only the bare architectural shell.\n\n' +

  'CRITICAL — SAME-COLOUR FURNITURE IS THE MOST COMMON FAILURE. READ THIS FIRST:\n' +
  'The most frequently missed items are furniture pieces whose colour closely matches the wall, floor, or ceiling (e.g. a cream sofa against a cream wall, a white chair against a white wall, a beige ottoman on a beige carpet). YOU MUST NOT SKIP THESE.\n' +
  'Colour alone is unreliable for detection. Use ALL of the following cues instead:\n' +
  '- FORM: manufactured objects have straight edges, flat faces, consistent curves — walls do not\n' +
  '- SHADOW: even a white sofa against a white wall casts a subtle shadow at its base and sides\n' +
  '- CONTACT POINT: furniture sits ON the floor — look for the line where an object meets the floor\n' +
  '- TEXTURE BREAK: fabric upholstery, leather, wood grain, and foam all have distinct micro-textures different from painted plaster or wallpaper\n' +
  '- DEPTH / PARALLAX: furniture sits in front of the wall surface — look for the depth break at its edges\n' +
  '- LOGICAL SCENE STRUCTURE: apply physical reasoning — a flat vertical surface is a wall, a horizontal surface with legs beneath it is a table\n' +
  'Scan the ENTIRE image methodically: foreground, mid-ground, background, corners, and edges. Do not stop after removing the obvious items.\n\n' +

  'EXHAUSTIVE REMOVAL LIST — remove every instance of:\n' +
  'Seating: sofas, sectionals, loveseats, armchairs, accent chairs, ottomans, poufs, benches, stools, dining chairs, bar stools\n' +
  'Tables: coffee tables, side tables, end tables, console tables, dining tables, desks, dressing tables, bedside tables, nightstands\n' +
  'Beds and bedroom: bed frames, mattresses, headboards, footboards, bed linen, pillows, bolsters, blankets, duvets\n' +
  'Storage: wardrobes, dressers, chest of drawers, TV units, entertainment centres, bookcases, shelving units, display cabinets, sideboards, buffets\n' +
  'Soft furnishings: rugs, carpets, runners, curtains, drapes, blinds (non-fixed), throws, cushions, decorative pillows\n' +
  'Decor and accessories: lamps (floor and table), picture frames, wall art, mirrors (freestanding or hung), plants, vases, ornaments, sculptures, candles, clocks, books, magazines\n' +
  'Electronics: televisions, monitors, speakers, gaming consoles, appliances (toasters, kettles, microwaves) unless permanently built in\n' +
  'Other: coat racks, shoe racks, laundry baskets, bins, bags, clothes, toys, exercise equipment, musical instruments\n\n' +

  'WHAT TO KEEP (do not remove or alter):\n' +
  'Fixed structure: walls, floors, ceilings, skirting boards, cornices, coving, architraves\n' +
  'Fixed openings: windows (frames, glass, fixed shutters), doors and door frames\n' +
  'Permanent fittings: built-in cabinets, fitted wardrobes, built-in shelving, kitchen units and worktops\n' +
  'Services: light switches, power sockets, radiators, pipes, air conditioning units, smoke detectors\n' +
  'Fixed light fixtures: ceiling lights, pendant lights, recessed spotlights, wall-mounted sconces that are hardwired\n\n' +

  'RESTORATION AFTER REMOVAL:\n' +
  'Where furniture is removed, reconstruct the underlying surface as it would naturally appear:\n' +
  '- Extend the wall colour, texture, and finish behind where objects were\n' +
  '- Extend flooring (wood grain direction, tile pattern, carpet texture) seamlessly under removed furniture\n' +
  '- Remove all shadows and light reflections that were caused solely by the removed objects\n' +
  '- Do not invent architectural features, windows, doors, or recesses that are not already visible in the image\n' +
  '- Match the existing ambient light direction when filling in restored areas\n\n' +

  'OUTPUT:\n' +
  'The result must look like a professionally photographed empty room — clean, well-lit, and ready for virtual staging. There should be zero traces of any removed item: no ghost shadows, no partial edges, no colour halos.';

async function createDefurnishingJob({ listing, photo }) {
  return createToolJob({
    listing,
    action: {
      actionId: syntheticActionId('defurnish', photo._id) + ':' + Date.now(),
      tool: 'defurnishing',
      photoId: photo._id,
      roomType: photo.analysis?.roomType || null,
      reasonCodes: ['user_request'],
    },
    prompt: DEFURNISHING_PROMPT,
  });
}

async function createFurnishingRenderJob({ listing, photo }) {
  const suggestion = photo.furnishingSuggestion;
  if (!suggestion?.generatedAt) throw new Error('No furnishing suggestion exists for this photo yet.');
  const pieceLines = (suggestion.pieces || [])
    .map((piece) => `- ${piece.item}: ${piece.placement}`)
    .join('\n');
  const lightingLines = (suggestion.lighting || [])
    .map((l) => `- ${l.item}: ${l.placement}`)
    .join('\n');
  const wt = suggestion.windowTreatments;
  const wtLine = wt?.type ? `Window treatments: ${wt.type} in ${wt.color || 'neutral tones'}.` : '';
  const paletteLine = suggestion.colorPalette?.length
    ? `Color palette: ${suggestion.colorPalette.join(', ')}.`
    : '';
  const dims = suggestion.estimatedDimensions || {};
  const dimsLine = dims.widthMeters && dims.lengthMeters
    ? `Estimated room size: ${dims.widthMeters}m x ${dims.lengthMeters}m.`
    : '';
  const bd = suggestion.bedding;
  const beddingLine = bd?.bedSize
    ? `Bedding: ${bd.bedSize} bed — ${bd.sheetColor || ''} sheets, ${bd.duvet || ''}, ${bd.pillowArrangement || ''}.`.replace(/,\s*,/g, ',').trim()
    : '';
  const style = suggestion.style || 'neutral';
  const prompt = `Style: ${style}${paletteLine ? `\n${paletteLine}` : ''}
${dimsLine ? `Room size: ${dimsLine}` : ''}

Furniture to place:
${pieceLines}
${lightingLines ? `\nLighting to place:\n${lightingLines}` : ''}
${wtLine ? `\n${wtLine}` : ''}
${beddingLine ? `\n${beddingLine}` : ''}`;
  return createToolJob({
    listing,
    action: {
      actionId: syntheticActionId('virtual-staging-render', photo._id) + ':' + Date.now(),
      tool: 'virtual_staging_render',
      photoId: photo._id,
      roomType: photo.analysis?.roomType || null,
      reasonCodes: ['furnishing_accepted'],
    },
    prompt,
  });
}

module.exports = {
  createToolJob,
  createCustomEditJob,
  createVirtualStagingJob,
  createEnhancementJob,
  createDefurnishingJob,
  createFurnishingRenderJob,
  publicToolJob,
  GEMINI_SUPPORTED_TOOLS,
};
