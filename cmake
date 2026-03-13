#!/bin/bash
#
# https://github.com/Lakelezz/audiopus_sys/issues/21
#
# Wrapper for cmake that adds the policy version flag
if [[ "$1" == "--build" ]]; then
    # For build commands, don't add the policy flag and filter out --parallel with number
    args=()
    skip_next=false
    for arg in "$@"; do
        if $skip_next; then
            skip_next=false
            continue
        fi
        if [[ "$arg" == "--parallel" ]]; then
            skip_next=true
            continue
        fi
        args+=("$arg")
    done
    exec cmake "${args[@]}"
else
    # For configure commands, add the policy flag
    exec cmake -DCMAKE_POLICY_VERSION_MINIMUM=3.5 "$@"
fi
