#!/usr/bin/env python3
"""R6: Resolve and dump the actual THEME attribute values from resources.arsc
of the shipped v3.4.2 APK. Looking for window sizing attrs:
windowFixedHeightMajor/Minor, windowMinWidthMajor/Minor, windowBackground,
windowSplashScreen*, windowLayoutInDisplayCutoutMode, etc.
"""
import logging, sys
from loguru import logger
logger.remove()
logging.disable(logging.CRITICAL)

from androguard.core.apk import APK

APK_PATH = "/home/z/my-project/download/v3.4.2-app-release.apk"
a = APK(APK_PATH)

# Resolve theme IDs from the manifest
theme_ids = {"application": "0x7f12000a", "MainActivity": "0x7f12022c"}

res = a.get_android_resources()
# Build id->name maps and package info
packages = res.get_packages_names()
print("resource packages:", packages)

def resolve_name(pkg, typ, ident):
    try:
        configs = res.get_resolved_res_configs(ident)
        # returns list of ((config), value)
        return configs
    except Exception as e:
        return [("ERR", str(e))]

# Find the res names for our IDs
for label, rid in theme_ids.items():
    ident = int(rid, 16)
    print(f"\n===== {label}: {rid} =====")
    try:
        name = res.get_resource_xml_name(ident)
        print("  resource name:", name)
    except Exception as e:
        print("  name resolve err:", e)
    # try to fetch values
    try:
        configs = res.get_resolved_res_configs(ident)
        for cfg, val in configs[:6]:
            print(f"   cfg={cfg} -> {val!r}")
    except Exception as e:
        print("   value resolve err:", e)

# Now dump every attribute referenced INSIDE those two styles if they are styles
# Use arsc via apkInspector style tables
from androguard.core.axml import AXMLPrinter
import zipfile

# androguard higher-level: get all styles containing 'Theme' in name
print("\n===== searching all style names for our themes =====")
try:
    for pkg in packages:
        types = res.get_types(pkg)
        for t in types:
            if t != "style":
                continue
            entries = res.get_res_configs_by_name(pkg, t) if False else None
except Exception as e:
    print("style search err:", e)

# fallback: brute force ID range for styles table via get_resource_xml_name
found = {}
for ident in list(range(0x7F120000, 0x7F121000)):
    try:
        nm = res.get_resource_xml_name(ident)
        if nm and ("style" in nm):
            found[ident] = nm
    except Exception:
        pass
for ident, nm in sorted(found.items()):
    if "022c" in hex(ident) or "000a" == hex(ident)[-4:]:
        print("MATCH:", hex(ident), nm)

print("\n=== dump attr entries of the two style IDs ===")
for label, rid in theme_ids.items():
    ident = int(rid, 16)
    print(f"\n--- {label} ({rid}) ---")
    try:
        # get_resolved_res_configs returns config->value; for styles the value is
        # a complex object (list of (attr_id, value)?) depending on androguard version
        configs = res.get_resolved_res_configs(ident)
        for cfg, val in configs:
            print(f"  [{cfg}]")
            try:
                items = val
                if hasattr(items, "items"):
                    for k, v in items.items():
                        print(f"    {k} = {v}")
                elif isinstance(items, (list, tuple)):
                    for k, v in items:
                        print(f"    {hex(k) if isinstance(k,int) else k} = {v}")
                else:
                    print(f"    {val!r}")
            except Exception as e:
                print("    parse err:", e, repr(val)[:200])
            break  # only default config
    except Exception as e:
        print("  err:", e)
