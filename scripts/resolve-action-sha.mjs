/**
 * Resolve `owner/repo` tag vX.Y.Z to the commit SHA it points at, for `uses: action@sha` pinning.
 *
 * A tag ref may be an annotated tag object or a direct commit; both have to be unwrapped to get the
 * commit the runner actually checks out. Usage: node scripts/resolve-action-sha.mjs owner/repo vX.Y.Z
 */
const [repo, tag] = process.argv.slice(2);
if (!repo || !tag) {
  console.error('usage: node scripts/resolve-action-sha.mjs owner/repo vX.Y.Z');
  process.exit(1);
}

const headers = {
  accept: 'application/vnd.github+json',
  'user-agent': 'phomymo-pin',
  ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

async function json(path) {
  const res = await fetch(`https://api.github.com/repos/${repo}/${path}`, { headers });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

const ref = await json(`git/ref/tags/${tag}`);
let sha = ref.object.sha;
let type = ref.object.type;
if (type === 'tag') {
  const annotated = await json(`git/tags/${sha}`);
  sha = annotated.object.sha;
  type = annotated.object.type;
}
console.log(`${repo}@${sha} # ${tag} (${type})`);