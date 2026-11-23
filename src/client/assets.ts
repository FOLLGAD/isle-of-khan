const SPRITES = [
  'tile-map', 'tree', 'enemy', 'wizard', 'heart', 'bomb', 'particle', 'arrow', 'bolt', 'crown', 'staff',
  'short-sword', 'bow-simple', 'archer', 'warrior', 'mage', 'coin', 'sam',
] as const;
export type SpriteName = (typeof SPRITES)[number];

export type Img = HTMLImageElement | HTMLCanvasElement;
export const img = {} as Record<SpriteName, HTMLImageElement>;
/** Same sprites as solid white, for hit flashes. */
export const flash = {} as Record<SpriteName, HTMLCanvasElement>;
/** Same sprites tinted red, for the bomb fuse. */
export const redFlash = {} as Record<SpriteName, HTMLCanvasElement>;

const load = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error(`Failed to load ${src}`));
    i.src = src;
  });

function tint(src: HTMLImageElement, color: string) {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const g = c.getContext('2d')!;
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

export async function loadAssets() {
  const font = new FontFace('GameFont', 'url(/assets/fonts/fffforwa.ttf)');
  await Promise.all([
    font.load().then((f) => document.fonts.add(f)),
    ...SPRITES.map(async (name) => {
      img[name] = await load(`/assets/sprites/${name}.png`);
      flash[name] = tint(img[name], '#fff');
      redFlash[name] = tint(img[name], '#ff3030');
    }),
  ]);
}
