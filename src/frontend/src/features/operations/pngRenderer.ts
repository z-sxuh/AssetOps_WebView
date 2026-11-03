async function encodeInWorker(image: HTMLImageElement, width: number, height: number): Promise<Blob | null> {
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || !OffscreenCanvas.prototype.transferToImageBitmap) return null;
  let worker: Worker;
  try { worker = new Worker(new URL('./topologyPng.worker.ts', import.meta.url), { type: 'module' }); } catch { return null; }
  let bitmap: ImageBitmap | undefined;
  try {
    const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);
    bitmap = canvas.transferToImageBitmap(); canvas.width = 0; canvas.height = 0;
    return await new Promise<Blob | null>((resolve, reject) => {
      worker.onmessage = ({ data }) => { if (data?.error) reject(new Error(data.error)); else resolve(data); };
      worker.onerror = event => { event.preventDefault(); resolve(null); };
      try { worker.postMessage(bitmap, [bitmap!]); } catch { resolve(null); }
    });
  } finally { bitmap?.close(); worker.terminate(); }
}

export async function renderTopologyPng(svg: string, width: number, height: number) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('拓扑图片渲染失败')); image.src = url; });
    const blob = await encodeInWorker(image, width, height) ?? await new Promise<Blob>((resolve, reject) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d'); if (!context) { reject(new Error('无法创建图片画布')); return; }
      context.drawImage(image, 0, 0, width, height);
      canvas.toBlob(value => { canvas.width = 0; canvas.height = 0; if (value) resolve(value); else reject(new Error('拓扑图片编码失败，请重试')); }, 'image/png');
    });
    return await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.onerror = () => reject(new Error('拓扑图片读取失败，请重试')); reader.readAsDataURL(blob); });
  } finally { URL.revokeObjectURL(url); }
}
