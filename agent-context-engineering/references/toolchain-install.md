# Toolchain Install

Instalación de las herramientas de retrieval en Linux (tasks 2.1-2.3).

## Binarios incluidos en el repo — opción preferida (sin acceso a repos públicos)

El script `scripts/download-binaries.sh` descarga binarios estáticos de `[rg, fd, jq, yq, ast-grep (>sg), tokei]` para **linux, darwin y win32** (x64 y arm64) a `bin/<os>-<arch>/`. Los scripts del proyecto anteponen ese directorio al PATH automáticamente (`scripts/env.sh`), priorizando los binarios del repo sobre los del sistema.

```bash
./scripts/download-binaries.sh   # requiere curl + tar + unzip; corre una vez
scripts/check-tools              # verifica resolución
```

Solo `probe` (retrieval semántico, opcional) no se incluye en el bundle por ser paquete npm.

## Fedora (dnf) — 2.1

```bash
sudo dnf install ripgrep fd-find jq yq fzf tokei
```

Notas:
- `ripgrep` → binario `rg`
- `fd-find` → binario `fd`
- `yq`, `tokei` están en repos Fedora
- Si no hay sudo: binarios estáticos en `~/.local/bin` (ver abajo)

### Fallback sin sudo (binarios estáticos)

```bash
mkdir -p ~/.local/bin
# yq (mikefarah)
curl -fsSL -o ~/.local/bin/yq https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64
chmod +x ~/.local/bin/yq
# tokei (usar tag con assets binarios; v14 no publica assets)
curl -fsSL -o /tmp/tokei.tar.gz https://github.com/XAMPPRocky/tokei/releases/download/v12.1.2/tokei-x86_64-unknown-linux-gnu.tar.gz
tar -xzf /tmp/tokei.tar.gz -C ~/.local/bin tokei
```

`~/.local/bin` debe estar en PATH (agregar a `~/.profile` si falta).

## ast-grep — 2.2

```bash
npm install -g @ast-grep/cli
```

Instala dos binarios: `ast-grep` y `sg` (alias corto).

## Probe — 2.3

```bash
npm install -g @probelabs/probe
```

Alternativa: installer Linux del proyecto (ver docs de zeroentropy-ai).

## Verificación — 2.4

```bash
scripts/check-tools
```

`command -v rg fd jq yq sg tokei probe`. Herramientas faltantes no bloquean la operación básica (el motor degrada a las disponibles).

Estado verificado (2026-08-14, esta máquina): 7/7 OK.
