import { Resvg } from "@resvg/resvg-js";
import pngToIco from "png-to-ico";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const previews = [];
for (const product of ["server", "studio"]) {
  const directory = resolve(
    import.meta.dirname,
    product === "server" ? "../assets" : "../../zhilume-studio/assets",
  );
  await mkdir(directory, { recursive: true });
  // Shared woven Z stays identical. A substantial badge remains recognizable
  // at taskbar sizes; shape differentiates the products without relying on hue.
  const badge = product === "studio"
    ? `<circle cx="408" cy="408" r="76" fill="#8aaaf0" stroke="#202124" stroke-width="10"/>
       <path d="m375 440 10-39 37-37 25 25-37 37z" fill="#202124"/>
       <path d="m385 401 25 25m-35 14 27-27" fill="none" stroke="#8aaaf0" stroke-width="6"/>
       <circle cx="404" cy="411" r="6" fill="#8aaaf0"/>`
    : `<circle cx="408" cy="408" r="76" fill="#a6bcb3" stroke="#202124" stroke-width="10"/>
       <rect x="368" y="373" width="80" height="28" rx="7" fill="#202124"/>
       <rect x="368" y="415" width="80" height="28" rx="7" fill="#202124"/>
       <path d="M380 387h25m-25 42h25" stroke="#a6bcb3" stroke-width="5" stroke-linecap="round"/>
       <circle cx="434" cy="387" r="4" fill="#a6bcb3"/><circle cx="434" cy="429" r="4" fill="#a6bcb3"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect x="16" y="16" width="480" height="480" rx="112" fill="#202124"/><rect x="25" y="25" width="462" height="462" rx="104" fill="none" stroke="#44464c" stroke-width="4"/><path d="M142 150h228L152 362h220" fill="none" stroke="#edf0f6" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/><path d="M154 244h82m50 24h72" fill="none" stroke="#8aaaf0" stroke-width="24" stroke-linecap="round"/>${badge}</svg>`;
  await writeFile(resolve(directory, "icon.svg"), svg);
  previews.push({ product, svg });
  const png = new Resvg(svg).render().asPng();
  await writeFile(resolve(directory, "icon.png"), png);
  await writeFile(resolve(directory, "icon.ico"), await pngToIco(png));
  console.log(`${product}: SVG, PNG and multi-resolution ICO generated`);
}
const previewDirectory = resolve(import.meta.dirname, "../docs/evidence/0.2.2");
await mkdir(previewDirectory, { recursive: true });
const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="220" viewBox="0 0 480 220">
  <rect width="480" height="220" rx="16" fill="#151619"/>
  ${[...previews].reverse().map(({ product, svg }, index) => `<g transform="translate(${50 + index * 240} 16)">
    <g transform="scale(0.2734375)">${svg.replace(/<svg[^>]*>|<\/svg>/g, "")}</g>
    <text x="70" y="180" text-anchor="middle" fill="#edf0f6" font-family="Segoe UI, sans-serif" font-size="18">${product === "studio" ? "Studio" : "Server"}</text>
  </g>`).join("")}
</svg>`;
await writeFile(resolve(previewDirectory, "icons.png"), new Resvg(preview).render().asPng());
