# StyleChat v0.4.1 Portrait UX Fix QA Notes

## Accepted Commits

- `b42bee2` - StyleChat delete conversation feature
- `9979814` - Portrait keyboard visibility, delete-dialog back behavior, session-label spacing, empty-state spacing

## Known Limitation - Landscape Docked Keyboard

Landscape docked Gboard can still cover the StyleChat input bar.

This behavior existed before commit `9979814` and was not introduced by the portrait UX fix.

Portrait docked keyboard input visibility is fixed and is the supported beta path.

Floating Gboard in landscape remains usable.

Landscape docked keyboard should be tracked separately if full landscape support becomes a beta requirement.
