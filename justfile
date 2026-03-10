set dotenv-load

default:
    just run

# Build frontend and run the server
run *args:
    cd frontend && npm run build
    cargo run {{args}}

# Build frontend and compile (no run)
build *args:
    cd frontend && npm run build
    cargo build {{args}}

# Run only cargo (skip frontend build)
cargo-run *args:
    cargo run {{args}}

# Frontend dev server
frontend-dev:
    cd frontend && npm run dev

# Check rust code
check:
    SQLX_OFFLINE=true cargo clippy --workspace --all-targets -- -D warnings

test *args:
    SQLX_OFFLINE=true cargo test --workspace {{args}}
