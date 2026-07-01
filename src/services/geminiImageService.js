const AssetVersion = require('../models/AssetVersion');
const { describeGeminiError } = require('./geminiErrorMessages');

function imageModel(tool, job, photo) {
  const flashModel = process.env.GEMINI_IMAGE_MODEL;
  const proModel   = process.env.GEMINI_IMAGE_MODEL_PRO;
  if (!flashModel) throw new Error('GEMINI_IMAGE_MODEL is not set in backend/.env');

  // Pro model is used for tasks that require precise scene understanding or fine
  // inpainting. Flash is used for instruction-following tasks (staging, edits)
  // where it performs comparably at lower cost and latency.
  //
  // photo_enhancement  — Pro: subtle exposure/colour/sharpness corrections.
  // defurnishing       — Pro: must detect furniture by form when colours match the
  //                     wall (e.g. cream sofa vs cream wall), then reconstruct the
  //                     background cleanly. Flash misses low-contrast objects.
  if (tool === 'photo_enhancement' || tool === 'defurnishing') {
    return proModel || flashModel;
  }
  return flashModel;
}

function isBlurRecreationJob(job, photo) {
  if (job.tool !== 'photo_enhancement') return false;
  const issues = photo.analysis?.issues || [];
  return issues.some((i) => /blur|out[\s-]?of[\s-]?focus|soft(?:\s*focus)?|unfocused|motion/i.test(i));
}

function buildTruthfulPrompt(job, photo) {
  const recommendation = photo.analysis?.recommendation || {};
  const structuralElements = recommendation.preserve?.length
    ? recommendation.preserve.join(', ')
    : 'walls, windows, doors, flooring, fixed fittings, room dimensions, and all factual property details';
  const issues = photo.analysis?.issues || [];
  const obstructionIssue = issues.find((i) => /obstruct|foreground/i.test(i));
  const obstructionHint = obstructionIssue
    ? '\nFocus on removing or minimizing the foreground obstruction. Blend the revealed area naturally with the existing background — do not invent new content.'
    : '';

  if (job.tool === 'custom_edit' && job.metadata?.sourceVersionId) {
    // This is a targeted edit of an already-generated image (e.g. a staged photo
    // still awaiting accept/reject) — not a fresh edit of the original upload.
    // The instruction in job.prompt was already built in createCustomEditJob to
    // include the prior staging context, so the only job here is to lock everything
    // else down as tightly as possible.
    return `${job.prompt}

This exact image (attached) is the photo to edit — it already shows a fully staged/edited real-estate room. Treat it as the ground truth for everything except the one change requested above.
Apply ONLY the requested change. Every other element in the image — every piece of furniture (including its type, color, style, and exact position), the walls, windows, doors, flooring, lighting, and camera angle — must remain pixel-for-pixel identical to the attached image.
Do not regenerate, restyle, reposition, add, or remove anything that wasn't explicitly requested.
Keep the result photorealistic and suitable for an honest property listing.
Return the edited image.`;
  }

  if (job.tool === 'custom_edit') {
    return `${job.prompt}

This is a real-estate listing image. Apply the requested change accurately and completely.
You MAY change: colors, textures, soft furnishings (bedding, cushions, curtains, rugs, throws), lighting effects, removable objects, and decorative items.
Do NOT change: ${structuralElements}.
Keep the result photorealistic and suitable for an honest property listing.
Return the edited image.`;
  }

  // Photo enhancement on a severely blurry source: a normal "correct and preserve
  // everything pixel-for-pixel" instruction is self-defeating here, since the blur
  // itself is part of what would be "preserved". Instead, ask the model to treat the
  // blurry photo as a layout/composition reference and re-render it in sharp focus —
  // same room, same furniture, same positions, but with real detail instead of blur.
  if (job.tool === 'photo_enhancement') {
    if (isBlurRecreationJob(job, photo)) {
      return `This is a blurry, low-detail reference photograph of a real-estate ${photo.analysis?.roomType || 'room'}.

Recreate this exact scene as a crystal-clear, sharp, high-resolution photograph, using the reference photo only as a layout and composition guide. Keep everything about the scene identical to the reference:
- The exact same furniture pieces, in the exact same positions and proportions.
- The exact same wall colors, flooring, window positions and sizes, doors, and ceiling fixtures.
- The exact same camera angle, framing, and field of view — do not zoom, pan, tilt, or reframe.
- The exact same outdoor view through any window.

The ONLY change you are making is bringing the entire image into sharp, in-focus detail: render realistic, crisp textures (fabric weave, wood grain, leaf detail, wall texture) and clear edges throughout, with natural lighting consistent with what's visible in the reference.

Preserve exactly (do not redesign or invent): ${structuralElements}.
Do not add, remove, relocate, resize, or invent any furniture, architecture, windows, doors, views, or fixtures beyond what's visible in the reference photo.
Keep the result photorealistic and suitable for an honest property listing — this must look like the same real room, simply brought into sharp focus, not a different or redecorated room.
Return the edited image.`;
    }
  }

  // Virtual staging: composite furniture onto the original photo — do not re-render the room.
  if (job.tool === 'virtual_staging_render') {
    // Pull every available detail from the prior Gemini analysis of this photo
    // and feed it back as a "what is already in this photo" checklist. This
    // grounds the model in the actual room rather than a generated version.
    const analysis = photo.analysis || {};
    const preserveList = recommendation.preserve?.length
      ? recommendation.preserve
      : ['walls', 'windows', 'doors', 'floor', 'ceiling', 'all fixed fixtures'];
    const reasoning = analysis.reasoning ? `Gemini's own description of this photo: "${analysis.reasoning}"` : '';
    const roomType = analysis.roomType || 'room';
    // The UI allows staging on already-furnished rooms too (a "restyle" use case),
    // but if the prompt keeps asserting "this is an empty room" for a room that
    // visibly already has furniture, the model has no instruction to remove what's
    // there — it just declines the contradictory edit and echoes the photo back
    // unchanged. Branch the framing on the real emptyRoom flag instead of assuming.
    const isEmpty = analysis.emptyRoom !== false;

    const sceneFraming = isEmpty
      ? `You are editing a real photograph of an empty ${roomType}. Study the attached photo carefully.`
      : `You are editing a real photograph of an already-furnished ${roomType}. Study the attached photo carefully — it currently contains furniture and decor that must be REMOVED and REPLACED with the new furniture plan below.`;

    const itemsInstruction = isEmpty
      ? `ITEMS TO ADD — these are the ONLY changes you may make to the photo:\n${job.prompt}`
      : `REMOVE every piece of furniture and decor currently visible in the photo (seating, beds, tables, rugs, art, plants, lamps, etc.) and stage the now-empty room with ONLY the following items:\n${job.prompt}`;

    return `${sceneFraming}

${itemsInstruction}

When placing each item, match the exact perspective, scale, and shadow direction already present in the photo.

━━━ EVERYTHING ELSE IS ALREADY IN THE PHOTO — DO NOT CHANGE IT ━━━

${reasoning}

The following elements are visible in the attached photo and must appear IDENTICALLY in your output:
${preserveList.map((el) => `- ${el}`).join('\n')}

Specific rules:
1. CAMERA: The output must be shot from the exact same position, angle, height, and focal length as the input. Do not zoom, pan, tilt, or reframe in any way.
2. WALLS: Same color, same texture, same corner angles. If walls meet at an L-shape or any angle, preserve that exact geometry.
3. WINDOWS: Every window in the input must appear in the output at the exact same position, size, and frame. The outdoor view through each window must be identical. Do NOT add, remove, resize, or move any window.
4. CEILING: Same height, same color. Every ceiling fixture (recessed lights, fan, vents) stays in its exact position — do not remove or replace any ceiling fixture.
5. FLOOR: Same material, color, and grain direction.
6. DOORS & ACCENT WALLS: All doors and wall finishes (shiplap, paneling, tiles) unchanged.
7. Any part of the room not covered by placed furniture must look pixel-identical to the input photo.

Return the edited image.`;
  }

  const basePrompt = `${job.prompt || recommendation.editPrompt}${obstructionHint}`;
  return `${basePrompt}

This is a real-estate listing image. Make only the requested truthful correction.
Preserve exactly: ${structuralElements}.
Do not add, enlarge, remove, relocate, or invent architecture, windows, doors, room area, views, fixtures, or permanent property features.
Keep the result photorealistic and suitable for an honest property listing.
Return the edited image.`;
}

async function runGeminiImageEdit(job, photo) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
  // If this job targets a specific prior generation (e.g. editing a staged photo
  // that's still pending review), use THAT image's bytes as the source — not the
  // original upload. Without this, every "edit" silently restaged from scratch.
  let source = photo.data; // Buffer pulled straight from MongoDB — no disk involved
  let sourceMimeType = photo.mimeType;
  if (job.metadata?.sourceVersionId) {
    const sourceVersion = await AssetVersion.findById(job.metadata.sourceVersionId);
    if (sourceVersion?.data) {
      source = sourceVersion.data;
      sourceMimeType = sourceVersion.mimeType || sourceMimeType;
    }
  }
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${imageModel(job.tool, job, photo)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: buildTruthfulPrompt(job, photo) },
              {
                inline_data: {
                  mime_type: sourceMimeType,
                  data: source.toString('base64'),
                },
              },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ['IMAGE', 'TEXT'],
          ...(job.tool === 'virtual_staging_render' ? { temperature: 1.0 } : {}),
          ...(job.tool === 'custom_edit' && job.metadata?.sourceVersionId ? { temperature: 0.15 } : {}),
          // No explicit imageConfig — Gemini's default (~1K) is a clear sharpness
          // upgrade over any blurry source and keeps file sizes small for fast
          // MongoDB writes and browser downloads. 2K / 4K added bulk with no
          // visible quality benefit for web-displayed real-estate photos.
        },
      }),
    }
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const known = describeGeminiError(response.status, body);
    if (known) {
      const err = new Error(known.message);
      err.geminiReason = known.reason;
      throw err;
    }
    const hint = response.status === 404
      ? ` — model "${imageModel(job.tool, job, photo)}" may be retired. Update GEMINI_IMAGE_MODEL / GEMINI_IMAGE_MODEL_PRO in backend/.env`
      : response.status === 400 && body.includes('text output')
        ? ` — model "${imageModel(job.tool, job, photo)}" does not support image output. Update GEMINI_IMAGE_MODEL in backend/.env`
        : response.status === 429
          ? ' — rate limited, try again shortly.'
          : '';
    throw new Error(`Gemini image editing failed (${response.status}): ${body.slice(0, 500)}${hint}`);
  }
  const payload = await response.json();
  const candidate = payload?.candidates?.[0];
  const finishReason = candidate?.finishReason;

  // Safety block, recitation, or other refusal
  if (finishReason && finishReason !== 'STOP') {
    const textParts = (candidate?.content?.parts || [])
      .filter((p) => p.text).map((p) => p.text).join(' ').slice(0, 300);
    const safetyMsg =
      finishReason === 'SAFETY'
        ? 'The model refused this edit (safety policy). Try rephrasing the prompt — e.g. say what to remove rather than referencing who/what it is.'
        : `Gemini stopped early (${finishReason}).`;
    throw new Error(`${safetyMsg}${textParts ? ' Model said: "' + textParts + '"' : ''}`);
  }

  const parts = candidate?.content?.parts || [];
  const imagePart = parts.find((part) => part.inlineData?.data || part.inline_data?.data);
  const inlineData = imagePart?.inlineData || imagePart?.inline_data;

  if (!inlineData?.data) {
    const textReply = parts.filter((p) => p.text).map((p) => p.text).join(' ').slice(0, 300);
    const modelUsed = imageModel(job.tool, job, photo);
    const textHint = textReply
      ? `Model replied with text only: "${textReply}"`
      : `Model "${modelUsed}" returned no image data.`;
    const fixHint = ` Check that your GEMINI_API_KEY has image-generation access enabled in Google AI Studio, and that GEMINI_IMAGE_MODEL is set to a model that supports image output.`;
    throw new Error(`${textHint}${fixHint}`);
  }

  const mimeType = inlineData.mimeType || inlineData.mime_type || 'image/png';
  const buffer = Buffer.from(inlineData.data, 'base64');

  const version = new AssetVersion({
    listing: job.listing,
    photo: photo._id,
    toolJob: job._id,
    kind: 'generated',
    url: 'pending', // placeholder, replaced below once we know the _id
    data: buffer,
    mimeType,
    sizeBytes: buffer.length,
    selected: false,
    metadata: {
      provider: 'gemini',
      model: imageModel(job.tool, job, photo),
      tool: job.tool,
      prompt: job.prompt,
      synthIdExpected: true,
    },
  });
  version.url = `/api/images/versions/${version._id}`;
  await version.save();
  return { version, url: version.url };
}

module.exports = { runGeminiImageEdit };