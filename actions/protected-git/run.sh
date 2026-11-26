#!/usr/bin/env bash
set -euo pipefail

record_reason() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'failure-reason=%s\n' "$1" >> "$GITHUB_OUTPUT"
  fi
}

case "$OPERATION" in
promote | merge) ;;
*) record_reason protected-git-failed; echo '::error::The protected Git writer requires promote or merge.'; exit 2 ;;
esac

if [ -z "$KEY" ]; then
  record_reason missing-promotion-key
  case "$OPERATION" in
  promote)
    echo "::error title=Promotion needs a trusted writer::Commit $SHA passed its checks. A trusted promoter can fast-forward $TARGET to that exact commit."
    {
      printf '### Promotion needs a trusted writer\n'
      printf 'From a clone of %s with write access, fast-forward %s to the checked commit.\n\n' "$REPOSITORY" "$TARGET"
      printf '~~~sh\ngit fetch origin %s\ngit push origin %s:refs/heads/%s\n~~~\n\n' "$SHA" "$SHA" "$TARGET"
    } >> "$GITHUB_STEP_SUMMARY"
    ;;
  merge)
    echo "::error title=Merge needs a trusted writer::Pull request #$NUMBER at $SHA passed its checks. A trusted merger can merge that exact head into $TARGET."
    {
      printf '### Merge needs a trusted writer\n\n'
      printf 'Merge [%s#%s](%s/%s/pull/%s) into %s only if the checked head is still %s. Use **Create a merge commit**.\n\n' \
        "$REPOSITORY" "$NUMBER" "$GITHUB_SERVER_URL" "$REPOSITORY" "$NUMBER" "$TARGET" "$SHA"
      printf '~~~sh\ngh pr merge %s --repo %s --merge --match-head-commit %s\n~~~\n\n' "$NUMBER" "$REPOSITORY" "$SHA"
    } >> "$GITHUB_STEP_SUMMARY"
    ;;
  esac
  printf 'Configure **PROMOTION_KEY** in the **%s** environment, or enroll an external trusted writer.\n' "$KEY_ENVIRONMENT" >> "$GITHUB_STEP_SUMMARY"
  exit 1
fi

case "$KEY" in
*"-----END OPENSSH PRIVATE KEY-----"*) ;;
*) record_reason invalid-promotion-key; echo '::error::PROMOTION_KEY holds no OpenSSH private key'; exit 1 ;;
esac

known_hosts=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/github-known-hosts
folder=$(mktemp -d "$RUNNER_TEMP/nddev-ci-git.XXXXXXXX")
trap 'cd -- / && rm -rf -- "$folder"' EXIT
(umask 077 && printf '%s\n' "$KEY" > "$folder/key")
unset KEY
export GIT_SSH_COMMAND="ssh -i \"$folder/key\" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=\"$known_hosts\" -o HostKeyAlias=github.com -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -p 443"

network_git() {
  local command=$1 status=0
  printf 'Starting %s git %s.\n' "$OPERATION" "$command"
  timeout --kill-after=5s 120s git "$@" || status=$?
  if [ "$status" -ne 0 ]; then
    record_reason protected-git-failed
    echo "::error title=Protected git $command failed::Git $command exited with status $status during $OPERATION."
    return "$status"
  fi
}

git init -q "$folder/repository"
cd "$folder/repository"
git remote add origin "git@ssh.github.com:$REPOSITORY.git"

case "$OPERATION" in
promote)
  # Fetch the target and checked path so Git can prove the update moves forward.
  network_git fetch -q --filter=blob:none origin "$SHA" "refs/heads/$TARGET"
  network_git push -q origin "$SHA:refs/heads/$TARGET"
  echo "$TARGET is at $SHA."
  ;;
merge)
  network_git fetch -q --filter=blob:none origin "+refs/heads/$TARGET:refs/remotes/origin/$TARGET" "$SHA"
  git checkout -q --detach "refs/remotes/origin/$TARGET"
  git -c user.name=nddev-ci -c user.email=nddev-ci@users.noreply.github.com -c commit.gpgsign=false \
    merge -q --no-ff --no-edit -m "Merge pull request #$NUMBER from $REPOSITORY/$HEAD_BRANCH" "$SHA"
  # GitHub rejects a divergent push if the target moves during the merge.
  network_git push -q origin "HEAD:refs/heads/$TARGET"
  echo "Merged pull request #$NUMBER into $TARGET."
  ;;
esac
