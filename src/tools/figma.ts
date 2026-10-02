import type { ToolDef } from "../backends/types.js";

const FIGMA_API = "https://api.figma.com/v1";

async function figmaFetch(
  apiKey: string,
  path: string,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${FIGMA_API}${path}`, {
    headers: { "X-Figma-Token": apiKey },
  });
  const body = await res.json().catch(() => ({ error: "non-JSON response" }));
  return { ok: res.ok, status: res.status, body };
}

/**
 * Fetch one or more Figma nodes by ID. Returns the raw node tree(s) including
 * `absoluteBoundingBox`, `fills`, `style` (text style), `characters`,
 * `cornerRadius`, and child nodes. The agent uses this to extract design
 * tokens, layout coordinates, and text content without guessing.
 *
 * The Figma node ID format accepted by humans is `123:456` or `123-456`. The
 * REST API requires `123:456` — this tool normalises the dash form.
 */
export async function buildFigmaGetNodeTool(apiKey: string): Promise<ToolDef> {
  const { z } = await import("zod");
  return {
    name: "figma_get_node",
    description:
      "Fetch one or more Figma nodes by ID from a design file. Returns the raw node tree(s) — bounding box, fills, text style, characters, corner radius, children. Use this to pull exact tokens (colors, font sizes, spacing) and layout coordinates. Pass fileKey + nodeIds; node IDs may use `:` or `-` separators.",
    inputSchema: {
      fileKey: z
        .string()
        .describe(
          "The Figma file key (the segment after /design/ in a Figma URL).",
        ),
      nodeIds: z
        .array(z.string())
        .min(1)
        .describe(
          "Array of node IDs to fetch (e.g. ['292:3565', '292:3586']). Dash form like '292-3565' is also accepted.",
        ),
      geometry: z
        .enum(["paths"])
        .optional()
        .describe(
          "Optional: set to 'paths' to include vector geometry. Costs significantly more tokens; omit unless you need vector path data.",
        ),
    },
    handler: async (input: unknown) => {
      const { fileKey, nodeIds, geometry } = input as {
        fileKey: string;
        nodeIds: string[];
        geometry?: "paths";
      };
      const normalised = nodeIds.map((id) => id.replace("-", ":"));
      const idsParam = encodeURIComponent(normalised.join(","));
      const geometryParam = geometry ? `&geometry=${geometry}` : "";
      const result = await figmaFetch(
        apiKey,
        `/files/${encodeURIComponent(fileKey)}/nodes?ids=${idsParam}${geometryParam}`,
      );
      if (!result.ok) {
        return {
          ok: false,
          output: `figma_get_node failed (HTTP ${result.status}): ${JSON.stringify(result.body)}`,
        };
      }
      return { ok: true, output: JSON.stringify(result.body, null, 2) };
    },
  };
}

/**
 * Render one or more Figma nodes as image URLs (PNG / JPG / SVG / PDF). The
 * returned URLs are S3-hosted and expire after ~30 minutes — the agent should
 * `curl` them into the workspace immediately.
 *
 * Use this for hero photography, product card imagery, or any node the agent
 * needs to display verbatim. Vectors / icons should use SVG; raster art PNG.
 */
export async function buildFigmaRenderNodeTool(
  apiKey: string,
): Promise<ToolDef> {
  const { z } = await import("zod");
  return {
    name: "figma_render_node",
    description:
      "Render one or more Figma nodes as image URLs (PNG/JPG/SVG/PDF). Returns short-lived signed URLs the agent should `curl` immediately into the workspace. Use for exporting hero images, card art, icons. SVG for vectors, PNG for photography.",
    inputSchema: {
      fileKey: z.string().describe("The Figma file key."),
      nodeIds: z
        .array(z.string())
        .min(1)
        .describe(
          "Array of node IDs to render. May use `:` or `-` separator.",
        ),
      format: z
        .enum(["png", "jpg", "svg", "pdf"])
        .default("png")
        .describe("Image format. Default png."),
      scale: z
        .number()
        .min(0.01)
        .max(4)
        .default(1)
        .describe("Image scale factor (raster formats only). 1 = native size."),
    },
    handler: async (input: unknown) => {
      const { fileKey, nodeIds, format, scale } = input as {
        fileKey: string;
        nodeIds: string[];
        format?: "png" | "jpg" | "svg" | "pdf";
        scale?: number;
      };
      const normalised = nodeIds.map((id) => id.replace("-", ":"));
      const idsParam = encodeURIComponent(normalised.join(","));
      const fmt = format ?? "png";
      const s = scale ?? 1;
      const result = await figmaFetch(
        apiKey,
        `/images/${encodeURIComponent(fileKey)}?ids=${idsParam}&format=${fmt}&scale=${s}`,
      );
      if (!result.ok) {
        return {
          ok: false,
          output: `figma_render_node failed (HTTP ${result.status}): ${JSON.stringify(result.body)}`,
        };
      }
      return { ok: true, output: JSON.stringify(result.body, null, 2) };
    },
  };
}

/**
 * Resolve image-fill references to downloadable URLs.
 *
 * When `figma_get_node` returns a node with an image fill, the fill contains
 * an `imageRef` (content hash). This tool maps every imageRef in the file to
 * a signed S3 URL — useful for downloading photography embedded in the design.
 */
export async function buildFigmaGetImageFillsTool(
  apiKey: string,
): Promise<ToolDef> {
  const { z } = await import("zod");
  return {
    name: "figma_get_image_fills",
    description:
      "Resolve every image-fill `imageRef` in a Figma file to a downloadable URL. Call this after `figma_get_node` finds an image fill, then `curl` the URL to save the asset locally.",
    inputSchema: {
      fileKey: z.string().describe("The Figma file key."),
    },
    handler: async (input: unknown) => {
      const { fileKey } = input as { fileKey: string };
      const result = await figmaFetch(
        apiKey,
        `/files/${encodeURIComponent(fileKey)}/images`,
      );
      if (!result.ok) {
        return {
          ok: false,
          output: `figma_get_image_fills failed (HTTP ${result.status}): ${JSON.stringify(result.body)}`,
        };
      }
      return { ok: true, output: JSON.stringify(result.body, null, 2) };
    },
  };
}
