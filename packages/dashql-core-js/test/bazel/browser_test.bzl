"""Core-only browser tests; no app bundle or database runtime is required."""

load("@aspect_rules_js//js:defs.bzl", "js_test")

def browser_test(name, browser, executable, runtime = None, executable_root = False, env = {}):
    browser_data = [executable]
    if runtime and runtime != executable:
        browser_data.append(runtime)
    test_env = {"DASHQL_BROWSER": browser}
    test_env.update(env)
    test_env["DASHQL_BROWSER_EXECUTABLE_ROOT" if executable_root else "DASHQL_BROWSER_EXECUTABLE"] = "$(rootpath {})".format(executable)
    js_test(
        name = name,
        size = "large",
        args = ["$(rootpath :bundle)"],
        data = [":bundle", "//:node_modules/playwright-core"] + browser_data,
        entry_point = "browser_test_driver.mjs",
        env = test_env,
        no_copy_to_bin = browser_data,
        visibility = ["//visibility:public"],
    )
