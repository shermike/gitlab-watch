// Prints one merge request's updated_at, user_notes_count and its ten newest notes, so the
// notifications design's §8 assumption and §4.3 wording can be checked against gitlab.com.
// Author names are not printed: the output is meant to be pasted into a conversation.
//
// Usage: node scripts/inspect-mr.mjs <group/project> <iid>
// Token: GITLAB_TOKEN, or the first line of ~/.gitlab-token. A read_api token is enough.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [project, iid] = process.argv.slice(2);
if (!project || !iid) {
  console.error('usage: node scripts/inspect-mr.mjs <group/project> <iid>');
  process.exit(2);
}

const token =
  process.env.GITLAB_TOKEN ??
  (await readFile(join(homedir(), '.gitlab-token'), 'utf8')).split('\n')[0].trim();
const base = `https://gitlab.com/api/v4/projects/${encodeURIComponent(project)}/merge_requests/${iid}`;

async function get(url) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`GET ${url} responded ${response.status}`);
  return response.json();
}

const mr = await get(base);
const notes = await get(`${base}/notes?sort=desc&order_by=created_at&per_page=10`);
console.log(`updated_at        ${mr.updated_at}`);
console.log(`user_notes_count  ${mr.user_notes_count}`);
for (const note of notes) {
  const kind = note.system ? 'system' : 'user  ';
  console.log(`${note.id}  ${kind}  ${note.created_at}  ${JSON.stringify(note.body.split('\n')[0])}`);
}
