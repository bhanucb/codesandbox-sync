import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { R2Settings } from "../config.js";
import type { Logger } from "../zip.js";
import type { RemoteZip, Storage } from "./types.js";

/**
 * Corporate networks usually require an egress proxy, and the AWS SDK does not
 * read the proxy environment variables the way curl and fetch do. Wiring the
 * agent explicitly is what makes this work from a locked-down machine.
 */
function proxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    undefined
  );
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/g, "");
  return trimmed.length > 0 ? `${trimmed}/` : "";
}

/**
 * Cloudflare R2 over the S3 API. Unlike the devbox backend there is no machine
 * to boot and no post-write settling: a successful PutObject means the object
 * is readable, so verification is a single HEAD rather than a retry loop.
 */
export class R2Storage implements Storage {
  readonly kind = "r2" as const;
  readonly location: string;
  readonly browseUrl: string;

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(settings: R2Settings, prefix: string) {
    this.bucket = settings.bucket;
    this.prefix = normalizePrefix(prefix);
    this.location = `s3://${this.bucket}/${this.prefix}`;
    this.browseUrl = `https://dash.cloudflare.com/${settings.accountId}/r2/default/buckets/${this.bucket}`;

    const proxy = proxyUrl();
    this.client = new S3Client({
      region: "auto",
      endpoint: settings.endpoint,
      credentials: {
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
      },
      // R2 serves path-style addressing; virtual-host style needs per-bucket
      // DNS that a plain account endpoint does not have.
      forcePathStyle: true,
      requestHandler: proxy
        ? new NodeHttpHandler({ httpsAgent: new HttpsProxyAgent(proxy) })
        : undefined,
    });
  }

  private key(name: string): string {
    return `${this.prefix}${name}`;
  }

  async list(log: Logger): Promise<RemoteZip[]> {
    const zips: RemoteZip[] = [];
    let continuationToken: string | undefined;

    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.prefix,
          ContinuationToken: continuationToken,
        })
      );
      for (const object of page.Contents ?? []) {
        const key = object.Key;
        if (!key || !key.endsWith(".zip")) {
          continue;
        }
        zips.push({
          name: key.slice(this.prefix.length),
          path: key,
          size: object.Size ?? 0,
          mtime: object.LastModified ? object.LastModified.getTime() : 0,
        });
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);

    zips.sort((a, b) => b.mtime - a.mtime);
    return zips;
  }

  async put(name: string, data: Buffer, log: Logger): Promise<string> {
    const key = this.key(name);
    log(`  Uploading ${data.length} bytes to s3://${this.bucket}/${key}…`);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: "application/zip",
        ContentLength: data.length,
      })
    );
    log(`  Upload completed`);

    log("Verifying upload…");
    const head = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key })
    );
    if (head.ContentLength !== data.length) {
      throw new Error(
        `Size mismatch! Expected ${data.length} bytes, got ${head.ContentLength} bytes`
      );
    }
    log(`  ✓ Size matches!`);
    return key;
  }

  async get(zip: RemoteZip, log: Logger): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: zip.path })
    );
    if (!response.Body) {
      throw new Error(`Empty response body for ${zip.path}`);
    }
    const bytes = await response.Body.transformToByteArray();
    return Buffer.from(bytes);
  }

  async remove(zip: RemoteZip, log: Logger): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: zip.path })
    );
  }

  close(log: Logger): void {
    try {
      this.client.destroy();
    } catch {
      // Ignore teardown errors
    }
  }
}
