# server must be imported before jev_ultrafast / browser_harness: it sets BU_NAME,
# which Browser Harness reads once at import. conftest loads before any test module.
import server  # noqa: F401
