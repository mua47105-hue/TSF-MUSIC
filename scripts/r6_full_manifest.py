#!/usr/bin/env python3
"""R6: FULL AndroidManifest dump of the shipped v3.4.2 APK.
Prints EVERY element + EVERY attribute (no filtering), so nothing can hide:
compatibleWidthLimitDp, minAspectRatio, <layout>, configChanges, meta-data...
"""
import sys, zipfile, re
from pyaxmlparser.axmlprinter import AXMLPrinter

APK = "/home/z/my-project/download/v3.4.2-app-release.apk"

with zipfile.ZipFile(APK) as z:
    names = [n for n in z.namelist() if n.endswith("AndroidManifest.xml")]
    data = z.read("AndroidManifest.xml")

xp = AXMLPrinter(data)
raw = xp.get_xml().decode("utf-8") if isinstance(xp.get_xml(), bytes) else xp.get_xml()

# pretty-ish print: newline before each tag
pretty = re.sub(r"><", ">\n<", raw)
print(pretty)
print("\n\n=== TOTAL LINES:", len(pretty.splitlines()))
