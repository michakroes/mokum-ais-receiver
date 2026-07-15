// Receives the /state snapshot from the Pi and stores it in Netlify Blobs.
// Auth via the x-ais-key header (must equal env AIS_PUSH_KEY).
import { getStore } from "@netlify/blobs";

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  const key = req.headers.get("x-ais-key");
  if (!process.env.AIS_PUSH_KEY || key !== process.env.AIS_PUSH_KEY) {
    return new Response("unauthorized", { status: 401 });
  }

  let state;
  try {
    state = JSON.parse(await req.text());
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const store = getStore("ais");
  await store.setJSON("latest", { receivedAt: Date.now(), state });

  return new Response("ok");
};
