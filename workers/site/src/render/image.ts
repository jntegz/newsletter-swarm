// The site's <img> for a media library image: dimensions so the layout doesn't jump, the focal
// point class, and resized copies when the Images binding is there. Used by cards and cover images.
import type { WebImage } from '@swarm/mail';
import { variantUrl } from '../edge/images';
import { h } from './html';

/** Widths offered in srcset (edge/images.ts WIDTHS), up to the image's own width. */
const SRCSET_WIDTHS = [320, 640, 960, 1280, 1920];

export function responsiveImage(
  image: WebImage,
  options: { eager: boolean; images: boolean; sizes: string },
): string {
  const [x, y] = image.objectPosition.split(' ').map((p) => Number.parseInt(p, 10));
  const size =
    image.width && image.height ? ` width="${image.width}" height="${image.height}"` : '';
  // Only media-library images (served at /media/ by this worker) have variants.
  const widths =
    options.images && image.url.includes('/media/') && !/\.(gif|pdf)$/i.test(image.url)
      ? SRCSET_WIDTHS.filter((w) => !image.width || w < image.width)
      : [];
  const srcset = widths.length
    ? ` srcset="${widths.map((w) => `${h(variantUrl(image.url, { kind: 'width', width: w }, true))} ${w}w`).join(', ')}${image.width ? `, ${h(image.url)} ${image.width}w` : ''}" sizes="${options.sizes}"`
    : '';
  return `<img class="sw-fp-${x ?? 50}-${y ?? 50}" src="${h(image.url)}"${srcset} alt="${h(image.alt)}"${size}${options.eager ? '' : ' loading="lazy"'} decoding="async">`;
}
