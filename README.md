# ImageFn

On-the-fly image transforms with Bun.Image. Paste a URL, resize, convert format, and share a link.

## Run locally

```bash
bun install
cp .env.example .env
bun run dev
```

Open [http://localhost:8787](http://localhost:8787). Docs: [http://localhost:8787/docs](http://localhost:8787/docs).

## Transform an image

```http
GET /i?url=<https-image-url>&w=800&h=800&fit=pad&fmt=webp&q=80
```

| Param | Meaning |
| --- | --- |
| `url` | HTTPS source image (required) |
| `w`, `h` | Output size |
| `fit` | `pad` (contain + white), `inside`, or `fill` (cover) |
| `fmt` | `webp`, `jpeg`, `png`, `avif`, or `auto` |
| `q` | Quality 1–100 |

## Docker

```bash
docker build -t image-fn .
docker run --rm -p 8787:8787 --env-file .env image-fn
```

## About

I’m Ved Gupta. I built this project to make live interview support faster and less distracting.

**Contact:** [vedgupta@protonmail.com](mailto:vedgupta@protonmail.com)

If you find the project useful, please star the repo on GitHub.
