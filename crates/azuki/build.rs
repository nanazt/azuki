use std::path::Path;
use std::process::Command;

fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let frontend_dir = Path::new(&manifest_dir).join("../../frontend");
    let frontend_dir = frontend_dir.canonicalize().unwrap_or(frontend_dir);

    // Only rerun when frontend sources change
    println!(
        "cargo:rerun-if-changed={}",
        frontend_dir.join("src").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        frontend_dir.join("package.json").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        frontend_dir.join("index.html").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        frontend_dir.join("vite.config.ts").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        frontend_dir.join("tsconfig.json").display()
    );

    // Skip if explicitly requested
    if std::env::var("SKIP_FRONTEND").is_ok() {
        return;
    }

    // Skip if frontend directory doesn't exist
    if !frontend_dir.join("package.json").exists() {
        return;
    }

    // npm install if node_modules missing
    if !frontend_dir.join("node_modules").exists() {
        println!("cargo:warning=Installing frontend dependencies...");
        let status = Command::new("npm")
            .arg("install")
            .current_dir(&frontend_dir)
            .status()
            .expect("failed to run npm install — is npm installed?");

        assert!(status.success(), "npm install failed (exited with {status})");
    }

    // Skip build if dist/index.html already exists and is fresh
    let dist_index = frontend_dir.join("dist/index.html");
    if dist_index.exists() {
        // Already built — rerun-if-changed handles invalidation
        return;
    }

    println!("cargo:warning=Building frontend...");
    let status = Command::new("npm")
        .args(["run", "build"])
        .current_dir(&frontend_dir)
        .status()
        .expect("failed to run npm run build — is npm installed?");

    assert!(status.success(), "frontend build failed (npm run build exited with {status})");
}
