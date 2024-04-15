#!/bin/bash

#  find . -name 'node_modules' -type d -prune -print -exec rm -rf '{}' +

# 编译要求要有tag
git tag -d selfbuildtest1
git tag selfbuildtest1

yarn install
yarn run build

