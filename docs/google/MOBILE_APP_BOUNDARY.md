# Mobile App Boundary — K Scan Google Glasses

## Main mobile app owns

- Expo mobile app
- User account flows
- StyleChat
- Dressing Rooms
- Saved scans
- Supabase client configuration
- Release AAB / app store builds

## Google Glasses owns

- Android XR / glasses capture and display prototype
- Device-specific safety/permission code
- XR privacy sanitizer path
- Glasses runtime tests
- Future bridge contracts

## Shared only by contract

- Backend API schemas
- Supabase table contracts
- Privacy requirements
- QA reports

## Integration rule

The Google Glasses app should integrate with K Scan through **backend APIs and shared data contracts**, not direct imports from the mobile repo.

Do not copy mobile app secrets into this workspace.
Do not edit the mobile app repo from this workspace.
