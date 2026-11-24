#!/bin/sh
# Stands in for ssh in end-to-end tests: serve every git fetch from $FAKE_GIT_REMOTE.
for last; do :; done
case "$last" in
  *git-upload-pack*) exec git-upload-pack "$FAKE_GIT_REMOTE" ;;
esac
exec git upload-pack "$FAKE_GIT_REMOTE"
