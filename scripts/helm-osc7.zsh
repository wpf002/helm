# Helm — emit OSC 7 so the app can track the shell's working directory.
#
# Source this from your ~/.zshrc:
#     source /Users/willfoti/Documents/GitHub/helm/scripts/helm-osc7.zsh
#
# Most terminals on macOS configure this themselves (Terminal.app does it via
# /etc/zshrc_Apple_Terminal); a bare zsh generally does not. Sourcing it when
# it is already configured is harmless — the hook is registered once.

if [[ -n "$ZSH_VERSION" ]] && [[ -z "$_HELM_OSC7_LOADED" ]]; then
  _HELM_OSC7_LOADED=1

  autoload -Uz add-zsh-hook

  _helm_osc7_emit() {
    # zsh's ${(j::)...} with percent-encoding: only unreserved characters pass
    # through untouched, so spaces and UTF-8 in paths survive the round trip.
    local encoded="${PWD//\%/%25}"
    local -a unsafe
    unsafe=(' ' '"' "'" '#' '?' '[' ']' '<' '>' '{' '}' '|' '\' '^' '`')
    local ch
    for ch in $unsafe; do
      encoded="${encoded//$ch/%$(printf '%02X' "'$ch")}"
    done
    printf '\e]7;file://%s%s\a' "${HOST:-localhost}" "$encoded"
  }

  add-zsh-hook precmd _helm_osc7_emit
  # Emit once now so the very first prompt is not blank.
  _helm_osc7_emit
fi

# Report each command to Helm so routeInput()'s verdict can be measured against
# what you actually ran. preexec sees the final line after history recall and
# completion, which nothing on Helm's side can reconstruct from keystrokes.
# Base64 keeps arbitrary quoting and UTF-8 intact inside the escape sequence.
if [[ "$TERM_PROGRAM" == "Helm" ]] && [[ -n "$ZSH_VERSION" ]] && [[ -z "$_HELM_PREEXEC_LOADED" ]]; then
  _HELM_PREEXEC_LOADED=1
  autoload -Uz add-zsh-hook

  _helm_report_command() {
    [[ -z "$1" ]] && return
    printf '\e]7373;%s\a' "$(printf '%s' "$1" | base64 | tr -d '\n')"
  }

  add-zsh-hook preexec _helm_report_command
fi

# Hand Helm the finished command line at the moment you press Enter.
#
# This is what lets you type plain English and get an answer without losing the
# shell. zsh keeps the line editor — history, completion, Ctrl+R, everything —
# and Helm only intercepts submission, at which point it has the final line
# rather than a guess reconstructed from keystrokes.
#
# Enter (^M) runs through the widget. Helm executes shell-bound lines by
# writing them back followed by ^J, which is still bound to accept-line, so
# there is no loop.
# Only inside Helm. This widget takes over Enter and hands the line to the app
# instead of executing it, so in any other terminal — iTerm, Terminal.app, a
# plain ssh session — pressing Enter would clear the line and run nothing.
# Sourcing this file from .zshrc must be safe everywhere.
if [[ "$TERM_PROGRAM" == "Helm" ]] && [[ -n "$ZSH_VERSION" ]] && [[ -z "$_HELM_SUBMIT_LOADED" ]]; then
  _HELM_SUBMIT_LOADED=1

  _helm_submit() {
    if [[ -z "$BUFFER" ]]; then
      zle accept-line
      return
    fi
    local encoded
    encoded=$(printf '%s' "$BUFFER" | base64 | tr -d '\n')
    BUFFER=""
    zle redisplay
    printf '\e]7374;%s\a' "$encoded"
  }

  zle -N _helm_submit
  bindkey '^M' _helm_submit

  # Tell Helm the widget is live, so it does not also try to intercept keys.
  printf '\e]7375;1\a'
fi

# Report the shell's own vocabulary — builtins, reserved words, autoloaded
# functions and your aliases — so routing knows what this shell can actually
# run. A hand-maintained list in TypeScript cannot know that `print` and
# `setopt` are zsh builtins, let alone that `gs` is your alias for git status,
# and every word it misses costs an API turn and a permission prompt.
if [[ "$TERM_PROGRAM" == "Helm" ]] && [[ -n "$ZSH_VERSION" ]] && [[ -z "$_HELM_VOCAB_LOADED" ]]; then
  _HELM_VOCAB_LOADED=1

  _helm_report_vocabulary() {
    local words
    words=$(
      {
        print -r -- ${(k)builtins}
        print -r -- ${(k)reswords}
        print -r -- ${(k)functions}
        print -r -- ${(k)aliases}
        print -r -- ${(k)commands}
        # The command names you have actually run. This is what teaches routing
        # about tools that are not installed here yet, and about anything else
        # a PATH scan cannot see.
        fc -l -n 1 2>/dev/null | awk '{print $1}'
      } 2>/dev/null | tr ' ' '\n' | sed 's/[;|&].*$//' | sort -u | tr '\n' ' '
    )
    [[ -z "$words" ]] && return
    printf '\e]7376;%s\a' "$(printf '%s' "$words" | base64 | tr -d '\n')"
  }

  _helm_report_vocabulary
fi
