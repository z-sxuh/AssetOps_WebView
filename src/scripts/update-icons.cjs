// 使用传入的 sharp 模块路径，从用户提供的 Logo 同步生成三主题 PNG 和多尺寸 ICO。
const fs = require('node:fs');
const path = require('node:path');
const sharp = require(process.argv[2] || 'sharp');
const directory = path.resolve(__dirname, '../frontend/src-tauri/icons/server_asset');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const palettes = {
  light: { background: '#fcfdfe', foreground: '#11395c' },
  dark: { background: '#3d3a33', foreground: '#f0ebdd' },
  spring: { background: '#f8fcf5', foreground: '#294b32' },
};

function bitmapIcon(rgba, size) {
  const maskStride = Math.ceil(size / 32) * 4;
  const bitmap = Buffer.alloc(40 + size * size * 4 + maskStride * size);
  bitmap.writeUInt32LE(40, 0);
  bitmap.writeInt32LE(size, 4);
  bitmap.writeInt32LE(size * 2, 8);
  bitmap.writeUInt16LE(1, 12);
  bitmap.writeUInt16LE(32, 14);
  bitmap.writeUInt32LE(size * size * 4, 20);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const source = (y * size + x) * 4;
    const target = 40 + ((size - 1 - y) * size + x) * 4;
    bitmap[target] = rgba[source + 2];
    bitmap[target + 1] = rgba[source + 1];
    bitmap[target + 2] = rgba[source];
    bitmap[target + 3] = rgba[source + 3];
    if (rgba[source + 3] === 0) bitmap[40 + size * size * 4 + (size - 1 - y) * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return bitmap;
}

async function generate() {
  const { data, info } = await sharp(path.join(directory, 'new_logo.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const mask = Buffer.alloc(info.width * info.height);
  let left = info.width, top = info.height, right = 0, bottom = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const pixel = y * info.width + x, offset = pixel * 4;
    // 原图为蓝色主体与近白色底；以色差保留抗锯齿边缘，去掉背景的细微灰阶。
    const alpha = Math.round(Math.max(0, Math.min(1, (data[offset + 2] - data[offset] - 3) / 72)) * data[offset + 3]);
    mask[pixel] = alpha;
    if (alpha > 25) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
  }
  const body = await sharp(mask, { raw: { width: info.width, height: info.height, channels: 1 } })
    .extract({ left, top, width: right - left + 1, height: bottom - top + 1 })
    .resize(820, 820, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
  const tileAlpha = await sharp(path.join(directory, 'new_logo.png')).resize(1024, 1024).ensureAlpha().extractChannel(3).raw().toBuffer();
  for (const [theme, palette] of Object.entries(palettes)) {
    const images = [];
    const foreground = palette.foreground.slice(1).match(/../g).map(hex => parseInt(hex, 16));
    const rgba = Buffer.alloc(body.info.width * body.info.height * 4);
    for (let pixel = 0; pixel < body.info.width * body.info.height; pixel++) {
      rgba.set(foreground, pixel * 4); rgba[pixel * 4 + 3] = body.data[pixel * body.info.channels];
    }
    const mark = await sharp(rgba, { raw: { width: body.info.width, height: body.info.height, channels: 4 } }).png().toBuffer();
    const placement = { input: mark, left: Math.floor((1024 - body.info.width) / 2), top: Math.floor((1024 - body.info.height) / 2) };
    const background = palette.background.slice(1).match(/../g).map(hex => parseInt(hex, 16));
    const tile = Buffer.alloc(1024 * 1024 * 4);
    for (let pixel = 0; pixel < tileAlpha.length; pixel++) { tile.set(background, pixel * 4); tile[pixel * 4 + 3] = tileAlpha[pixel]; }
    const source = await sharp(tile, { raw: { width: 1024, height: 1024, channels: 4 } }).composite([placement]).png().toBuffer();
    const taskbar = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#00000000' } })
      .composite([placement]).png().toBuffer();
    for (const size of sizes) {
      const image = await sharp(source).resize(size, size).png().toBuffer();
      fs.writeFileSync(path.join(directory, `server_asset_app_${theme}_${size}.png`), image);
      // Explorer 的小图标使用标准 BGRA DIB，256px 保留 PNG；两种编码来自同一组像素。
      images.push(size === 256 ? image : bitmapIcon(await sharp(image).ensureAlpha().raw().toBuffer(), size));
    }
    const header = Buffer.alloc(6 + sizes.length * 16);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(sizes.length, 4);
    let offset = header.length;
    images.forEach((image, index) => {
      const entry = 6 + index * 16;
      header[entry] = header[entry + 1] = sizes[index] % 256;
      header.writeUInt16LE(1, entry + 4);
      header.writeUInt16LE(32, entry + 6);
      header.writeUInt32LE(image.length, entry + 8);
      header.writeUInt32LE(offset, entry + 12);
      offset += image.length;
    });
    fs.writeFileSync(path.join(directory, `server_asset_app_${theme}.ico`), Buffer.concat([header, ...images]));
    for (const size of [16, 32]) {
      await sharp(taskbar).resize(size, size).png()
        .toFile(path.join(directory, `server_asset_taskbar_${theme}_${size}.png`));
    }
  }
  fs.copyFileSync(path.join(directory, 'server_asset_app_light.ico'), path.join(directory, '../icon.ico'));
}

generate().catch((error) => { console.error(error); process.exitCode = 1; });
