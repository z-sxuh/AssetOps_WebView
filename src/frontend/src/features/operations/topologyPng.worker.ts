self.onmessage = async ({ data: bitmap }: MessageEvent<ImageBitmap>) => {
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
    if (!context || typeof canvas.convertToBlob !== 'function') { bitmap.close(); self.postMessage(null); return; }
    context.drawImage(bitmap, 0, 0); bitmap.close();
    self.postMessage(await canvas.convertToBlob({ type: 'image/png' }));
  } catch {
    bitmap.close(); self.postMessage({ error: '拓扑图片编码失败，请重试' });
  }
};
