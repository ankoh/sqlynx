#!/bin/bash

import glob
from lxml import etree

namespaces = {'svg': 'http://www.w3.org/2000/svg'}
out = etree.Element("svg", None, namespaces)

for icon_path in glob.glob("./packages/sqlynx-app/static/svg/icons/*.svg"):
    with open(icon_path, "r", encoding="utf-8") as file:
        xml = etree.parse(file)
        root = xml.getroot()
        #etree.dump(root)
        for sym in root.findall('.//{http://www.w3.org/2000/svg}symbol', namespaces):
            out.append(sym)
            
with open('./packages/sqlynx-app/static/svg/icons.generated.svg', 'w') as f:
    f.truncate()
    tree = etree.ElementTree(out)
    etree.canonicalize(tree, strip_text=True, out=f)
