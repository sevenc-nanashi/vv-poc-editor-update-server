import { Context, Hono } from "hono";
import * as YAML from "@std/yaml";
import { HTTPException } from "hono/http-exception";
import {
  UpdateInfo as BaseElectronUpdateInfo,
  PackageFileInfo,
} from "electron-updater";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => {
  return c.redirect(
    "https://github.com/sevenc-nanashi/vv-poc-editor-update-server",
  );
});

type VvUpdateInfo = {
  version: string;
  descriptions: string[];
  contributors: string[];
};

type ToWritable<T> = {
  -readonly [P in keyof T]: T[P];
};

type ElectronUpdateInfo = ToWritable<BaseElectronUpdateInfo> & {
  packages?: Record<string, ToWritable<PackageFileInfo>>;
};

async function getLatestVersion(): Promise<string> {
  const updateInfos = await fetch(
    "https://voicevox.hiroshiba.jp/updateInfos.json",
  ).then((res) => {
    if (!res.ok) {
      throw new HTTPException(500, {
        message: "Failed to fetch updateInfos.json",
      });
    }
    return res.json() as Promise<VvUpdateInfo[]>;
  });

  if (updateInfos.length === 0) {
    throw new HTTPException(404, {
      message: "No update information found",
    });
  }

  const latestUpdateInfo = updateInfos[0];
  return latestUpdateInfo.version;
}

// latest.yml, latest-mac.yml, latest-win.yml, latest-linux.yml
app.get("/:artifact/:name{.+\\.yml}", async (c) => {
  const { artifact, name } = c.req.param();
  const latest = "999.0.1"; // await getLatestVersion();

  const latestInfo = await fetch(
    `https://huggingface.co/sevenc-nanashi/vv-poc-editor-update-storage/resolve/main/${latest}/${artifact}/${name}`,
  )
    .then((res) => {
      if (!res.ok) {
        throw new HTTPException(500, {
          message: "Failed to fetch latest update info",
        });
      }
      return res.text();
    })
    .then((text) => YAML.parse(text) as ElectronUpdateInfo);
  if (!latestInfo) {
    throw new HTTPException(404, {
      message: "Latest update info not found",
    });
  }

  latestInfo.path = `/${artifact}/${latest}/${latestInfo.path}`;
  for (const file of latestInfo.files) {
    file.url = `/${artifact}/${latest}/${file.url}`;
  }
  if (latestInfo.packages) {
    for (const file of Object.values(latestInfo.packages)) {
      file.path = `/${artifact}/${latest}/${file.path}`;
    }
  }

  // 面倒なので、JSONで返す。YAMLはJSONのスーパーセットなので問題ないはず。
  return c.json(latestInfo, 200, {
    "Content-Type": "application/x-yaml",
  });
});

app.get("/:artifact/:version/:file", async (c) => {
  const { version, artifact, file } = c.req.param();
  const urls = [
    `https://huggingface.co/sevenc-nanashi/vv-poc-editor-update-storage/resolve/main/${version}/${artifact}/${file}`,
    `https://github.com/sevenc-nanashi/voicevox/releases/download/${version}/${file}`,
  ];
  for (const url of urls) {
    const res = await fetch(url, {
      redirect: "manual",
    });
    if (res.status.toString().startsWith("3")) {
      return c.redirect(url);
    }
  }

  return c.json(
    {
      message: `File not found: ${file} for version ${version} in artifact ${artifact}`,
    },
    404,
  );
});

export default app;
