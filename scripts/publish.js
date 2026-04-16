#!/usr/bin/env node
/**
 * Batch publish captured clips to YouTube.
 *
 * Reads all .json sidecar files from a capture folder,
 * gets AI-rewritten copy + access token from the Netlify function,
 * then uploads each video directly to YouTube.
 *
 * Usage:
 *   node scripts/publish.js <capture-folder> [--dry-run]
 *
 * Options:
 *   --dry-run   Show what would be uploaded without actually uploading
 *   --unlisted  Upload as unlisted (default: private)
 *
 * Requires the site to be deployed with YouTube OAuth env vars configured.
 */

const fs = require('fs');
const path = require('path');

const SITE_URL = process.env.SITE_URL || 'https://vhsgarage.com';
const PUBLISH_ENDPOINT = `${SITE_URL}/.netlify/functions/youtube-publish`;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const unlisted = args.includes('--unlisted');
const folder = args.find(a => !a.startsWith('--'));

if (!folder) {
  console.log('Usage: node scripts/publish.js <capture-folder> [--dry-run] [--unlisted]');
  process.exit(1);
}

if (!fs.existsSync(folder)) {
  console.error(`Folder not found: ${folder}`);
  process.exit(1);
}

async function main() {
  // Find all .json sidecar files
  const files = fs.readdirSync(folder).filter(f => f.endsWith('.json') && f !== 'catalog.json');

  if (!files.length) {
    console.log('No sidecar .json files found in', folder);
    return;
  }

  console.log(`Found ${files.length} clip(s) to publish\n`);

  for (const jsonFile of files) {
    const jsonPath = path.join(folder, jsonFile);
    const metadata = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const videoFile = metadata.filename;

    if (!videoFile) {
      console.log(`  SKIP ${jsonFile}: no filename in metadata`);
      continue;
    }

    const videoPath = path.join(folder, videoFile);
    if (!fs.existsSync(videoPath)) {
      console.log(`  SKIP ${jsonFile}: video file ${videoFile} not found`);
      continue;
    }

    console.log(`  Publishing: ${metadata.title || videoFile}`);

    // Get AI copy + access token
    let prepared;
    try {
      const res = await fetch(PUBLISH_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'prepare', metadata }),
      });
      prepared = await res.json();
      if (prepared.error) {
        console.log(`    ERROR: ${prepared.error}`);
        continue;
      }
    } catch (e) {
      console.log(`    ERROR fetching token: ${e.message}`);
      continue;
    }

    console.log(`    AI Title: ${prepared.title}`);
    console.log(`    Tags: ${prepared.tags}`);

    if (dryRun) {
      console.log(`    [DRY RUN] Would upload ${videoFile}\n`);
      continue;
    }

    // Upload to YouTube
    try {
      const videoData = fs.readFileSync(videoPath);
      const uploadMetadata = {
        snippet: {
          title: prepared.title,
          description: prepared.description,
          tags: prepared.tags.split(',').map(t => t.trim()),
          categoryId: '22', // People & Blogs
        },
        status: {
          privacyStatus: unlisted ? 'unlisted' : 'private',
          selfDeclaredMadeForKids: false,
        },
      };

      // YouTube resumable upload: init
      const initRes = await fetch(
        'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${prepared.accessToken}`,
            'Content-Type': 'application/json',
            'X-Upload-Content-Type': videoFile.endsWith('.webm') ? 'video/webm' : 'video/mp4',
            'X-Upload-Content-Length': String(videoData.length),
          },
          body: JSON.stringify(uploadMetadata),
        }
      );

      if (!initRes.ok) {
        const err = await initRes.text();
        console.log(`    UPLOAD INIT ERROR: ${initRes.status} ${err}`);
        continue;
      }

      const uploadUrl = initRes.headers.get('location');
      if (!uploadUrl) {
        console.log(`    ERROR: No upload URL returned`);
        continue;
      }

      // Upload the video data
      const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': videoFile.endsWith('.webm') ? 'video/webm' : 'video/mp4',
          'Content-Length': String(videoData.length),
        },
        body: videoData,
      });

      if (uploadRes.ok) {
        const result = await uploadRes.json();
        console.log(`    UPLOADED: https://youtube.com/watch?v=${result.id}`);

        // Save YouTube URL back to the sidecar
        metadata.youtubeUrl = `https://youtube.com/watch?v=${result.id}`;
        metadata.youtubeId = result.id;
        fs.writeFileSync(jsonPath, JSON.stringify(metadata, null, 2));
      } else {
        const err = await uploadRes.text();
        console.log(`    UPLOAD ERROR: ${uploadRes.status} ${err}`);
      }
    } catch (e) {
      console.log(`    ERROR: ${e.message}`);
    }

    console.log('');
  }

  console.log('Done!');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
