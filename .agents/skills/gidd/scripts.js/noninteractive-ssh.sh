#!/bin/sh
# Git runs this helper in the actual transport cwd, with its -c options and
# submodule configuration already propagated. Do not resolve SSH from the
# wrapper's initial repository, or replace a user's key/proxy configuration.
command=$GIDD_SSH_COMMAND
program=
if test -z "$command"; then
    command=$(GIT_CONFIG_PARAMETERS="$GIDD_SSH_CONFIG_PARAMETERS" "$GIDD_BOUND_GIT" config --get core.sshCommand)
    status=$?
    if test "$status" -gt 1; then exit "$status"; fi
fi
if test -z "$command"; then
    program=${GIDD_SSH_PROGRAM:-ssh}
fi
variant=$GIT_SSH_VARIANT
if test -z "$variant"; then
    variant=$(GIT_CONFIG_PARAMETERS="$GIDD_SSH_CONFIG_PARAMETERS" "$GIDD_BOUND_GIT" config --get ssh.variant)
    status=$?
    if test "$status" -gt 1; then exit "$status"; fi
fi
if test -z "$variant" || test "$variant" = auto; then
    # Unknown shell commands must declare their protocol with ssh.variant.
    # Avoid executing a custom program just to guess its command-line dialect.
    name=${program:-${command%% *}}
    name=${name##*/}
    case "$name" in
        ssh|ssh.exe) variant=ssh ;;
        *) echo 'GIDD: noninteractive SSH requires an explicit ssh.variant (ssh, plink or tortoiseplink).' >&2; exit 1 ;;
    esac
fi
case "$variant" in
    ssh) batch=-oBatchMode=yes ;;
    plink|tortoiseplink) batch=-batch ;;
    *) echo 'GIDD: unsupported noninteractive SSH variant.' >&2; exit 1 ;;
esac
if test -n "$program"; then
    exec "$program" "$batch" "$@"
fi
# core.sshCommand / GIT_SSH_COMMAND are native shell commands. Preserve their
# meaning and safely append Git's separate arguments, including spaces/quotes.
exec sh -c "$command $batch \"\$@\"" -- "$@"
