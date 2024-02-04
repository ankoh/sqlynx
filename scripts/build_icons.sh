#!/usr/bin/env bash

iconutil -c icns ./misc/app_icons_mac.iconset

ICONSET=./misc/app_icons_mac.iconset/
ICNS=./misc/app_icons_mac.icns
OUT=./packages/sqlynx-native/icons/

rm ${OUT}/*
cp ${ICNS}                          ${OUT}/icon.icns
cp ${ICONSET}/icon_512x512@2x.png   ${OUT}/icon.png
cp ${ICONSET}/icon_16x16.png        ${OUT}/16x16.png
cp ${ICONSET}/icon_16x16@2x.png     ${OUT}/16x16@2x.png
cp ${ICONSET}/icon_32x32.png        ${OUT}/32x32.png
cp ${ICONSET}/icon_32x32@2x.png     ${OUT}/32x32@2x.png
cp ${ICONSET}/icon_64x64.png        ${OUT}/64x64.png
cp ${ICONSET}/icon_64x64@2x.png     ${OUT}/64x64@2x.png
cp ${ICONSET}/icon_128x128.png      ${OUT}/128x128.png
cp ${ICONSET}/icon_128x128@2x.png   ${OUT}/128x128@2x.png
cp ${ICONSET}/icon_256x256.png      ${OUT}/256x256.png
cp ${ICONSET}/icon_256x256@2x.png   ${OUT}/256x256@2x.png
cp ${ICONSET}/icon_512x512.png      ${OUT}/512x512.png
cp ${ICONSET}/icon_512x512@2x.png   ${OUT}/512x512@2x.png
