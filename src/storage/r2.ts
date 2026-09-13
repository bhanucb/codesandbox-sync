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

/**
 * The SDK's own failure for a non-S3 response is "XML parse error: expected >",
 * with the body hidden behind an internal field — which says nothing about the
 * actual cause. On a corporate network the cause is almost always an
 * interceptor answering instead of R2, so name that and show what came back.
 */
export function describeFailure(error: unknown, endpoint: string): Error {
  const err = error as {
    message?: string;
    $response?: {
      statusCode?: number;
      headers?: Record<string, string>;
      body?: unknown;
    };
  };
  const response = err?.$response;
  const contentType = response?.headers?.["content-type"] ?? "";
  const status = response?.statusCode;
  const looksLikeMarkup =
    /^(text\/html|application\/xhtml)/i.test(contentType) ||
    /XML parse error|expected >|Deserialization error/i.test(err?.message ?? "");

  if (!looksLikeMarkup) {
    return error instanceof Error ? error : new Error(String(error));
  }

  const body = typeof response?.body === "string" ? response.body : "";
  const snippet = body.trim().replace(/\s+/g, " ").slice(0, 300);

  return new Error(
    [
      `${endpoint} did not return an S3 response.`,
      status ? `  HTTP ${status}${contentType ? ` (${contentType})` : ""}` : undefined,
      snippet ? `  Body: ${snippet}` : undefined,
      "",
      "Something on the network answered instead of R2 — usually a proxy block",
      "page, a captive portal, or a TLS-intercepting gateway. Check, in order:",
      `  1. curl -s -D - "${endpoint}/?list-type=2" | head -25`,
      "     Real R2 returns XML; HTML means an interceptor.",
      "  2. Does egress need a proxy? Set HTTPS_PROXY.",
      "  3. Does that proxy intercept TLS? Set NODE_EXTRA_CA_CERTS to the",
      "     corporate root CA.",
    ]
      .filter((line) => line !== undefined)
      .join("\n")
  );
}

function toKeyPrefix(prefix: string): string {
  const trimmed = prefix.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/g, "");
  return trimmed.length > 0 ? `${trimmed}/` : "";
}

/**
 * Cloudflare R2 over the S3 API. A successful PutObject means the object is
 * readable, so verification is a single HEAD rather than a retry loop.
 */
export class R2Storage implements Storage {
  readonly location: string;
  readonly browseUrl: string;

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly endpoint: string;

  constructor(settings: R2Settings, prefix: string) {
    this.bucket = settings.bucket;
    this.prefix = toKeyPrefix(prefix);
    this.endpoint = settings.endpoint;
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

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private async send<T>(command: any): Promise<T> {
    try {
      return (await this.client.send(command)) as T;
    } catch (error) {
      throw describeFailure(error, this.endpoint);
    }
  }

  async list(log: Logger): Promise<RemoteZip[]> {
    const zips: RemoteZip[] = [];
    let continuationToken: string | undefined;

    do {
      const page = await this.send<import("@aws-sdk/client-s3").ListObjectsV2CommandOutput>(
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
    await this.send(
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
    const head = await this.send<import("@aws-sdk/client-s3").HeadObjectCommandOutput>(
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
    const response = await this.send<import("@aws-sdk/client-s3").GetObjectCommandOutput>(
      new GetObjectCommand({ Bucket: this.bucket, Key: zip.path })
    );
    if (!response.Body) {
      throw new Error(`Empty response body for ${zip.path}`);
    }
    const bytes = await response.Body.transformToByteArray();
    return Buffer.from(bytes);
  }

  async remove(zip: RemoteZip, log: Logger): Promise<void> {
    await this.send(
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
