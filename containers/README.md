# containers

One subdirectory per service holding its `Dockerfile` (and `.dockerignore`),
created by `scripts/new-app.sh`. The build context defaults to the matching
`typescript/<app>/` or `python/<app>/` source dir.

Optional per-app overrides the build-images workflow honors:

- `containers/<app>/context.txt` — override the Docker build context path.
- `containers/<app>/platforms.txt` — override build platforms (default
  `linux/amd64,linux/arm64`); one platform per line.
