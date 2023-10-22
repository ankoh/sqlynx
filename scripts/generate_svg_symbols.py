#!/bin/bash

import glob
from lxml import etree

namespaces = {'x': 'http://www.w3.org/2000/svg'}
out = etree.Element("svg", None, namespaces)

parser = etree.XMLParser(remove_blank_text=True)
def parse(path):
    with open(path, "r", encoding="utf-8") as file:
        xml = etree.parse(file, parser)
        root = xml.getroot()
        for sym in root.findall('.//{http://www.w3.org/2000/svg}symbol', namespaces):
            out.append(sym)

parse("./packages/sqlynx-app/static/svg/logo/logo.svg")
for icon_path in glob.glob("./packages/sqlynx-app/static/svg/icons/*.svg"):
    parse(icon_path)
            
with open('./packages/sqlynx-app/static/svg/symbols.generated.svg', 'wb') as f:
    f.truncate()
    tree = etree.ElementTree(out)
    tree.write(f, encoding='utf-8', pretty_print=False)
