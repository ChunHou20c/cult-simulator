// Rasterises a pack's emblem (an SVG data: URL) onto a canvas, for the 2D
// and 3D scenes. Cached per URL and size; resolves null if it can't load.
const cache = new Map<string, Promise<HTMLCanvasElement | null>>();

export function emblemCanvas(url: string | undefined, px = 256): Promise<HTMLCanvasElement | null> {
  if (!url) return Promise.resolve(null);
  const key = `${px}:${url}`;
  let p = cache.get(key);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = c.height = px;
        c.getContext("2d")?.drawImage(img, 0, 0, px, px);
        resolve(c);
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
    cache.set(key, p);
  }
  return p;
}
