import test from "node:test";
import assert from "node:assert/strict";
import { describeFailure } from "../dist/storage/r2.js";

const ENDPOINT = "https://acct.r2.cloudflarestorage.com";

test("an HTML response is reported as an interceptor, not an XML bug", () => {
  // What a corporate proxy block page actually produces inside the SDK.
  const sdkError = Object.assign(
    new Error("XML parse error: expected > at the end of opening tag."),
    {
      $response: {
        statusCode: 403,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "<html><title>Access Denied — Corporate Gateway</title></html>",
      },
    }
  );

  const message = describeFailure(sdkError, ENDPOINT).message;
  assert.match(message, /did not return an S3 response/);
  assert.match(message, /HTTP 403 \(text\/html/);
  assert.match(message, /Corporate Gateway/);
  assert.match(message, /HTTPS_PROXY/);
  assert.match(message, /NODE_EXTRA_CA_CERTS/);
});

test("a genuine S3 error passes through untouched", () => {
  // Credentials and missing-bucket failures must keep their own wording.
  const s3Error = Object.assign(new Error("The specified bucket does not exist"), {
    name: "NoSuchBucket",
    $response: { statusCode: 404, headers: { "content-type": "application/xml" } },
  });

  const out = describeFailure(s3Error, ENDPOINT);
  assert.equal(out, s3Error);
  assert.equal(out.message, "The specified bucket does not exist");
});

test("a transport failure is not mistaken for an interceptor", () => {
  const netError = Object.assign(new Error("getaddrinfo ENOTFOUND"), {
    name: "Error",
  });
  assert.equal(describeFailure(netError, ENDPOINT).message, "getaddrinfo ENOTFOUND");
});
