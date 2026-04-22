import { S3Client } from '@aws-sdk/client-s3';
import { SNSClient } from '@aws-sdk/client-sns';

const region = process.env.AWS_REGION ?? 'ap-northeast-2';
const endpoint = process.env.AWS_ENDPOINT_URL;

export const s3 = new S3Client({
  region,
  endpoint,
  forcePathStyle: !!endpoint, // LocalStack requires path-style
  credentials: endpoint
    ? { accessKeyId: 'test', secretAccessKey: 'test' }
    : undefined,
});

export const sns = new SNSClient({
  region,
  endpoint,
  credentials: endpoint
    ? { accessKeyId: 'test', secretAccessKey: 'test' }
    : undefined,
});
