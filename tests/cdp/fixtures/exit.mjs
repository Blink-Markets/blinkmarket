// Test fixture for tests/cdp-redact.test.ts: prints one line and exits with a fixed code.
process.stdout.write("exiting\n");
process.exitCode = 3;
