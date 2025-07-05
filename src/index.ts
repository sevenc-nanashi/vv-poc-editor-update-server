import { Context, Hono } from "hono";
import { Octokit, RestEndpointMethodTypes } from "@octokit/rest";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import * as YAML from "@std/yaml";
import { HTTPException } from "hono/http-exception";
import { stream } from "hono/streaming";

const app = new Hono<{ Bindings: Env }>();

const getOctokit = (c: Context<{ Bindings: Env }>) => {
  const { GITHUB_TOKEN } = c.env;
  if (!GITHUB_TOKEN) {
    throw new HTTPException(500);
  }

  const octokit = new (Octokit.plugin(paginateRest))({
    auth: GITHUB_TOKEN,
  });
  return octokit;
};

app.get("/", (c) => {
  return c.redirect(
    "https://github.com/sevenc-nanashi/vv-poc-editor-update-server",
  );
});

app.get("/latest.yml", async (c) => {
  return c.text(
    YAML.stringify({
      version: "0.24.1",
      files: [
        {
          url: "versions/0.24.1/VOICEVOX.Web.Setup.0.24.1.exe",
          sha512:
            "Cxjmb6zwCvQBokqhxceOyo6+2h59pJRJ5d7y3oETeuZ2mZoL1k9wyD27P19JRVMl3/EiFd2Jq+NCv6qklKy6xg==",
        },
      ],
      path: "versions/0.24.1/VOICEVOX-Web-Setup-0.24.1.exe",
      sha512:
        "Cxjmb6zwCvQBokqhxceOyo6+2h59pJRJ5d7y3oETeuZ2mZoL1k9wyD27P19JRVMl3/EiFd2Jq+NCv6qklKy6xg==",
      packages: {
        x64: {
          size: 1599350206,
          sha512:
            "x/2MCWjEtp5WnJyyU4w3pVCtXWsHI04K/1WBOObilYDv5iK3aEsXlp2xB9/0ArgJL06rZ+ZgzHb0j0wL3ZTzjw==",
          blockMapSize: 1652641,
          path: "versions/0.24.1/voicevox-0.24.1-x64.nsis.7z",
          file: "voicevox-0.24.1-x64.nsis.7z",
        },
      },
      releaseDate: "2025-07-04T01:10:43.917Z",
    }),
  );
});
async function getAssets(
  c: Context<{ Bindings: Env }>,
): Promise<
  RestEndpointMethodTypes["repos"]["getReleaseByTag"]["response"]["data"]["assets"]
> {
  const octokit = getOctokit(c);
  const release = await octokit.repos.getReleaseByTag({
    owner: "voicevox",
    repo: "voicevox",
    tag: c.req.param("version"),
  });
  if (!release.data.assets) {
    throw new HTTPException(404, { message: "Release not found" });
  }
  const assets = release.data.assets.filter(
    (a) =>
      a.name === c.req.param("file") ||
      new RegExp(`^${c.req.param("file")}.[0-9]+$`).test(a.name),
  );
  if (assets.length === 0) {
    throw new HTTPException(404, { message: "Asset not found" });
  }
  if (assets.length > 1) {
    assets.sort((a, b) => {
      const lastDotA = a.name.lastIndexOf(".");
      const lastDotB = b.name.lastIndexOf(".");
      const partA = Number.parseInt(a.name.substring(lastDotA + 1));
      const partB = Number.parseInt(b.name.substring(lastDotB + 1));
      return partA - partB;
    });
  }

  return assets;
}
app.get("/versions/:version/:file", async (c) => {
  const assets = await getAssets(c);
  c.header("Accept-Ranges", "bytes");
  c.header("Content-Type", "application/octet-stream");

  c.header(
    "Content-Length",
    String(assets.map((a) => a.size).reduce((a, b) => a + b, 0)),
  );

  if (c.req.method === "HEAD") {
    return c.body(null, 204);
  }

  let start = 0;
  let end = assets.map((a) => a.size).reduce((a, b) => a + b, 0) - 1;
  if (c.req.header("Range")) {
    const range = c.req.header("Range");
    const match = range.match(/^bytes=(\d+)-(\d+)?$/);
    if (!match) {
      throw new HTTPException(400, { message: "Invalid Range header" });
    }
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : end;
  }

  if (
    start < 0 ||
    end >= assets.map((a) => a.size).reduce((a, b) => a + b, 0)
  ) {
    throw new HTTPException(416, {
      message: "Requested range not satisfiable",
    });
  }

  c.header(
    "Content-Range",
    `bytes ${start}-${end}/${assets.map((a) => a.size).reduce((a, b) => a + b, 0)}`,
  );
  c.header("Content-Length", String(end - start + 1));
  return stream(c, async (stream) => {
    let currentBytes = 0;
    for (const asset of assets) {
      if (currentBytes + asset.size <= start) {
        currentBytes += asset.size;
        continue;
      }
      const assetStart = Math.max(0, start - currentBytes);
      const assetEnd = Math.min(asset.size - 1, end - currentBytes);

      currentBytes += asset.size;
      console.log(
        `Fetching asset ${asset.name} from ${assetStart} to ${assetEnd}`,
      );
      const response = await fetch(asset.browser_download_url, {
        headers: {
          Range: `bytes=${assetStart}-${assetEnd}`,
        },
      });
      if (!response.ok) {
        throw new HTTPException(404, { message: "Asset not found" });
      }
      const reader = response.body?.getReader();
      if (!reader) {
        throw new HTTPException(500, { message: "Failed to read asset" });
      }
      let bytesRead = 0;
      console.log(response.headers.get("Content-Length"));
      console.log(response.headers.get("Content-Range"));
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (stream.closed) {
          return;
        }
        if (value.length + bytesRead > assetEnd - assetStart + 1) {
          throw new HTTPException(500, {
            message: `Read more bytes than expected: ${value.length + bytesRead} > ${assetEnd - assetStart + 1}`,
          });
        } else {
          bytesRead += value.length;
          await stream.write(value);
        }
      }
      reader.cancel();

      if (bytesRead !== assetEnd - assetStart + 1) {
        throw new HTTPException(500, {
          message: `Expected ${assetEnd - assetStart + 1} bytes, but got ${bytesRead} bytes`,
        });
      }
      console.log(
        `Wrote ${bytesRead} bytes for asset ${asset.name} from ${assetStart} to ${assetEnd}`,
      );
      if (currentBytes > end) {
        break;
      }
    }
    console.log("Stream completed");
    await stream.close();
  });
});

export default app;
