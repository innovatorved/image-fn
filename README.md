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

## Azure multi-region mode

`image-fn` runs statelessly across `eastus`, `westus2`, and `northeurope` behind
Azure Standard Load Balancers + Azure Front Door. Raw originals and transformed
variants live in Azure Blob Storage, so any region can serve any request.

```bash
# Passwordless (VM System-Assigned Managed Identity) in production:
AZURE_REGION=eastus AZURE_STORAGE_ACCOUNT_NAME=stimagefnprod01 bun run start

# Create the containers once per storage account
bun run storage:init
```

| Endpoint | Description |
| --- | --- |
| `GET /health` | Probe for Azure Load Balancer / Front Door: `{ status, region, bun, storageConfigured }` |
| `POST /api/upload` | Validate with `Bun.Image` metadata, then store the raw original in `raw-images` |
| `GET /api/transform?url=…` | SHA-256 cached transform of an external image |
| `GET /api/transform?blob=…` | SHA-256 cached transform of a stored original |

Storage behaviour:

- **Auth precedence**: `AZURE_STORAGE_CONNECTION_STRING` (access key) first — when set, `DefaultAzureCredential` is never constructed; otherwise **passwordless** `DefaultAzureCredential` on Azure VMs.
- **RA-GRS failover**: reads retry against `<account>-secondary.blob.core.windows.net` if `eastus` is down.
- **Region-local replica**: set `AZURE_REPLICA_STORAGE_ACCOUNT_NAME` on European VMs to read from the locally Object-Replicated account first (Managed Identity only).
- Responses report the source: `X-Cache: HIT-AZURE-BLOB`, `HIT-AZURE-REPLICA`, or `MISS-TRANSFORMED` (write-through).
- `/health` reports `storageAuth: "connection-string" | "managed-identity"` and `storageReady`.

The legacy `/i` route also uses the shared Azure cache (L2) behind its per-instance
in-memory cache (L1), so existing embeds keep working. See `.env.example` for all
variables.

### Lab / subscription without Managed Identity

If your tenant can't assign VM identities or RBAC roles, use the access-key
connection string. It takes precedence over Managed Identity, so no code change
is needed:

```bash
# Storage account -> Security + networking -> Access keys -> Connection string
export AZURE_STORAGE_CONNECTION_STRING='DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net'
export AZURE_REGION=centralindia
bun run storage:init   # creates raw-images + processed-cache
bun run start          # /health now reports storageAuth: "connection-string"
```

To boot a whole VM this way, use [`deploy/azure/cloud-init.yaml`](deploy/azure/cloud-init.yaml):
paste your connection string into the `AZURE_STORAGE_CONNECTION_STRING` placeholder,
auto-detect the region from IMDS, clone this branch, and start a `systemd` service
with a `/health` smoke test.

> Treat connection strings as secrets. For production prefer Managed Identity (or
> fetch the key from Key Vault at boot); cloud-init custom data is readable by
> anyone with access to the VM resource.

## Docker

```bash
docker build -t image-fn .
docker run --rm -p 8787:8787 --env-file .env image-fn
```

## About

I’m Ved Gupta. I built this project to make live interview support faster and less distracting.

**Contact:** [vedgupta@protonmail.com](mailto:vedgupta@protonmail.com)

If you find the project useful, please star the repo on GitHub.
