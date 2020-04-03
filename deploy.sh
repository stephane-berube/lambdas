#!/bin/bash -xe

if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <foldername> [functionName]"
    echo ""
    echo "Example: $0 ised-create-jira-issue"
    exit 1
fi

function clean() {
    local folderName=$1
    local artifactFolder=$2
    local artifact="${artifactFolder}/${folderName}.zip"

    # If the artifact folder exists, check if we already have an old
    # zip artifact for this lambda, if so delete it.
    if [ -d "${artifactFolder}" ]; then
        if [ -f "${artifact}" ]; then
            rm "${artifact}"
        fi
    # If the artifact folder doesn't exist, create it
    else
        mkdir "${artifactFolder}"
    fi

    # Clean the "vendor" directory for that lambda if it exists
    pushd "${folderName}"

    if [ -d vendor ]; then
        rm -r vendor
    fi

    popd
}

function build() {
    local folderName=$1
    pushd "${folderName}"

    if [ -f requirements.txt ]; then
        mkdir -p vendor
        pip install --target vendor -r requirements.txt
    fi

    popd
}

function compress() {
    local rootDir
    rootDir=$(dirs -l +0)

    local folderName=$1
    local artifactFolder="${rootDir}/$2"

    pushd "${folderName}"

    if [ -d vendor ]; then
        pushd vendor

        zip -r9 "${artifactFolder}/${folderName}.zip" .
        popd
        
        rm -r vendor
    fi

    zip -gr "${artifactFolder}/${folderName}.zip" ./*

    popd
}

function deploy() {
    local functionName=$1
    local artifact=$2

    aws lambda update-function-code --function-name "${functionName}" --zip-file fileb://"${artifact}"
}

folderName=$1
artifactFolder="out"
artifact="${artifactFolder}/${folderName}.zip"

# If we've not been given a function name, assume it's the same as the folder name
if [ -z ${2+x} ]; then
    functionName="${folderName}"
else
    functionName=$2
fi

clean "${folderName}" "${artifactFolder}"
build "${folderName}"
compress "${folderName}" "${artifactFolder}"
deploy "${functionName}" "${artifact}"

