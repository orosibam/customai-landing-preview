import { readFile } from 'node:fs/promises';
import { STORAGE_BUCKET } from '../config.js';
import { db } from './supabase.js';

const CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
};

function contentTypeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

export async function uploadFile(localPath: string, remotePath: string): Promise<string> {
  const body = await readFile(localPath);
  const { error } = await db()
    .storage.from(STORAGE_BUCKET)
    .upload(remotePath, body, { contentType: contentTypeFor(remotePath), upsert: true });
  if (error) throw new Error(`스토리지 업로드 실패 (${remotePath}): ${error.message}`);
  return remotePath;
}

export async function downloadFile(remotePath: string, localPath: string): Promise<string> {
  const { data, error } = await db().storage.from(STORAGE_BUCKET).download(remotePath);
  if (error || !data) throw new Error(`스토리지 다운로드 실패 (${remotePath}): ${error?.message}`);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(localPath, Buffer.from(await data.arrayBuffer()));
  return localPath;
}

/** 대시보드 미리보기용 임시 URL. 기본 12시간. */
export async function signedUrl(remotePath: string, expiresInSec = 43_200): Promise<string> {
  const { data, error } = await db()
    .storage.from(STORAGE_BUCKET)
    .createSignedUrl(remotePath, expiresInSec);
  if (error || !data) throw new Error(`서명 URL 생성 실패 (${remotePath}): ${error?.message}`);
  return data.signedUrl;
}
