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
