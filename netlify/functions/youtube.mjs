const API_KEY = process.env.YOUTUBE_API_KEY_V3;
const YT_BASE = 'https://www.googleapis.com/youtube/v3';

export default async (req) => {
  if (!API_KEY) {
    return new Response(JSON.stringify({ error: 'YouTube API key not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get('action');

  if (action === 'resolve') {
    return resolveChannel(url.searchParams.get('name'));
  }

  if (action === 'videos') {
    return fetchVideos(url.searchParams.get('channelId'));
  }

  return new Response(JSON.stringify({ error: 'Unknown action' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
};

async function resolveChannel(name) {
  if (!name) {
    return json({ error: 'Missing name param' }, 400);
  }

  // Try forUsername first
  let res = await fetch(
    `${YT_BASE}/channels?part=id,snippet&forUsername=${encodeURIComponent(name)}&key=${API_KEY}`
  );
  let data = await res.json();

  if (data.items?.length) {
    return json({
      channelId: data.items[0].id,
      channelName: data.items[0].snippet.title,
    });
  }

  // Try as handle (@username) via search
  res = await fetch(
    `${YT_BASE}/search?part=snippet&q=${encodeURIComponent(name)}&type=channel&maxResults=1&key=${API_KEY}`
  );
  data = await res.json();

  if (data.items?.length) {
    return json({
      channelId: data.items[0].id.channelId,
      channelName: data.items[0].snippet.title,
    });
  }

  return json({ error: 'Channel not found' }, 404);
}

async function fetchVideos(channelId) {
  if (!channelId) {
    return json({ error: 'Missing channelId param' }, 400);
  }

  const res = await fetch(
    `${YT_BASE}/search?part=snippet&channelId=${encodeURIComponent(channelId)}&type=video&maxResults=50&order=date&key=${API_KEY}`
  );
  const data = await res.json();

  if (data.error) {
    return json({ error: data.error.message }, data.error.code || 500);
  }

  const videos = (data.items || []).map((i) => i.id.videoId);
  return json({ videos });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
