/**
 * @vitest-environment jsdom
 */

import mermaid from 'mermaid';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import { getCachedMermaidDiagram, renderMermaidDiagram } from '../lib/mermaid.ts';

afterEach(() => vi.restoreAllMocks());

const luminance = (color: string) => {
  const channels = color.match(/\d+/g)?.map(Number);
  expect(channels).toHaveLength(3);
  return channels!.reduce((sum, channel, index) => {
    const s = channel / 255;
    const linear = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    return sum + [0.2126, 0.7152, 0.0722][index] * linear;
  }, 0);
};

test('the real Mermaid parser rejects image nodes before rendering and keeps the queue usable', async () => {
  // Keep the real parser and configuration; drawing requires browser SVG layout APIs.
  const render = vi.spyOn(mermaid, 'render').mockResolvedValue({
    diagramType: 'flowchart',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"></svg>',
  });
  const image = vi.spyOn(window, 'Image');

  for (const metadata of [
    'img: "https://example.com/slow.png"',
    String.raw`"\u0069mg": "https://example.com/escaped.png"`,
    'img: "data:image/png;base64,iVBORw0KGgo="',
  ]) {
    const code = `flowchart TD\nA@{${metadata}, label: "Image"}`;
    await expect(renderMermaidDiagram(code, 'default')).rejects.toThrow(
      'Images are not supported in Mermaid diagrams',
    );
    expect(getCachedMermaidDiagram(code, 'default')).toBe(null);
  }
  expect(render).not.toHaveBeenCalled();
  expect(image).not.toHaveBeenCalled();

  await expect(
    renderMermaidDiagram('flowchart TD\nqueue-->continues', 'default'),
  ).resolves.toMatchObject({ height: 100, width: 200 });
  expect(render).toHaveBeenCalledTimes(1);
});

test('real Mermaid configuration keeps HTML labels disabled against frontmatter and init overrides', async () => {
  vi.spyOn(mermaid, 'render').mockResolvedValue({
    diagramType: 'flowchart',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"></svg>',
  });
  await renderMermaidDiagram('flowchart TD\ninitialize-->security', 'dark');

  for (const directive of [
    '---\nconfig:\n  htmlLabels: true\n  flowchart:\n    htmlLabels: true\n  securityLevel: loose\n  secure: []\n---',
    '%%{init: {"htmlLabels": true, "flowchart": {"htmlLabels": true}, "securityLevel": "loose", "secure": []}}%%',
  ]) {
    await mermaid.parse(`${directive}\nflowchart TD\nA["One<br/>Two"]-->B`);
    const config = mermaid.mermaidAPI.getConfig();
    expect(config.htmlLabels).toBe(false);
    expect(config.flowchart?.htmlLabels).not.toBe(true);
    expect(config.securityLevel).toBe('strict');
    expect(config.secure).toContain('htmlLabels');
    expect(config.secure).toContain('securityLevel');
  }
});

test.each([
  ['sequenceDiagram\nClient->>Worker: Start job', 'text.messageText'],
  ['flowchart LR\nClient -->|Start job| Worker', '.edgeLabel .label text'],
])('renders high-contrast arrow labels only in dark mode (%s)', async (code, labelSelector) => {
  // jsdom can render the SVG structure but does not implement SVG geometry.
  const geometry = Object.getOwnPropertyDescriptors(SVGElement.prototype);
  Object.defineProperties(SVGElement.prototype, {
    getBBox: { configurable: true, value: () => ({ height: 24, width: 96, x: 0, y: 0 }) },
    getComputedTextLength: { configurable: true, value: () => 96 },
  });

  try {
    for (const theme of ['dark', 'default'] as const) {
      const { src } = await renderMermaidDiagram(code, theme);
      const svg = new DOMParser().parseFromString(
        decodeURIComponent(src.slice(src.indexOf(',') + 1)),
        'image/svg+xml',
      );
      const label = svg.querySelector(labelSelector)!;
      expect(label.textContent).toContain('Start job');
      // Put the serialized stylesheet in the HTML document so jsdom applies it to the SVG.
      const stylesheet = document.createElement('style');
      stylesheet.textContent = svg.querySelector('style')?.textContent ?? '';
      const root = svg.documentElement;
      document.head.append(stylesheet);
      document.body.append(root);
      try {
        const style = getComputedStyle(label);
        if (theme === 'dark') {
          expect(style.getPropertyValue('paint-order')).toBe('stroke');
          const fill = luminance(style.getPropertyValue('fill'));
          const outline = luminance(style.getPropertyValue('stroke'));
          expect((fill + 0.05) / (outline + 0.05)).toBeGreaterThan(7);
        } else {
          expect(style.getPropertyValue('paint-order')).not.toBe('stroke');
        }
      } finally {
        root.remove();
        stylesheet.remove();
      }
    }
  } finally {
    for (const key of ['getBBox', 'getComputedTextLength']) {
      if (geometry[key]) {
        Object.defineProperty(SVGElement.prototype, key, geometry[key]);
      } else {
        Reflect.deleteProperty(SVGElement.prototype, key);
      }
    }
  }
});
