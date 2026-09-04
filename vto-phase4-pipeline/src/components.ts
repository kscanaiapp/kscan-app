export interface ComponentStats {
  id: number;
  size: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ConnectedComponentsResult {
  labels: Int32Array;
  components: ComponentStats[];
}

/** 4-connected flood-fill labeling over a boolean (0/1) mask. Iterative (stack-based) — safe for large images with no recursion depth risk. */
export function labelConnectedComponents(mask: Uint8Array, width: number, height: number): ConnectedComponentsResult {
  const labels = new Int32Array(mask.length).fill(-1);
  const components: ComponentStats[] = [];
  const stack: number[] = [];

  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1 || labels[start] !== -1) continue;

    const id = components.length;
    let size = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    stack.push(start);
    labels[start] = id;

    while (stack.length > 0) {
      const idx = stack.pop() as number;
      const x = idx % width;
      const y = Math.floor(idx / width);
      size++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      const neighbors = [
        x > 0 ? idx - 1 : -1,
        x < width - 1 ? idx + 1 : -1,
        y > 0 ? idx - width : -1,
        y < height - 1 ? idx + width : -1,
      ];
      for (const n of neighbors) {
        if (n >= 0 && mask[n] === 1 && labels[n] === -1) {
          labels[n] = id;
          stack.push(n);
        }
      }
    }

    components.push({ id, size, minX, minY, maxX, maxY });
  }

  return { labels, components };
}

export function largestComponent(components: readonly ComponentStats[]): ComponentStats | null {
  if (components.length === 0) return null;
  return components.reduce((best, c) => (c.size > best.size ? c : best), components[0]);
}
