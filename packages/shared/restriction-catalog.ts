/**
 * Restriction catalog — descriptions, defaults, and recommendations for
 * all known iOS/iPadOS restriction keys, sourced from Apple's MDM documentation:
 * https://developer.apple.com/documentation/devicemanagement/restrictions
 *
 * Used by:
 * - admin UI (descriptions, recommendations, default-aware display)
 * - profile generation (filter out values matching defaults)
 */

export type RestrictionType = "boolean" | "integer" | "real" | "string";

export interface RestrictionMeta {
  key: string;
  type: RestrictionType;
  description: string;
  /** Apple's documented default value (already typed). null = no default / array type. */
  defaultValue: boolean | number | string | null;
  /** A short recommendation for a kids' iPad profile. */
  recommendation: string;
  /** Whether this restriction is age/user-specific (can be overridden per theme/child). */
  overridable: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────

/** Boolean restrictions that default to true (the "allow" default). */
const T = true;
/** Boolean restrictions that default to false (the "force" default). */
const F = false;

// ── Catalog ────────────────────────────────────────────────────────

export const RESTRICTION_CATALOG: RestrictionMeta[] = [
  { key: "allowAccountModification", type: "boolean", description: "If false, the system disables modification of accounts, such as Apple Accounts, and internet-based accounts, such as Mail, Contacts, and Calendar.", defaultValue: T, recommendation: "Disable — prevents kids from adding/removing accounts.", overridable: false },
  { key: "allowActivityContinuation", type: "boolean", description: "If false, the system disables activity continuation (Handoff).", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowAddingGameCenterFriends", type: "boolean", description: "If false, the system prohibits adding friends to Game Center.", defaultValue: T, recommendation: "Disable — prevents unsupervised social contact.", overridable: false },
  { key: "allowAirDrop", type: "boolean", description: "If false, the system disables AirDrop.", defaultValue: T, recommendation: "Disable — prevents sharing files with strangers.", overridable: false },
  { key: "allowAirPlayIncomingRequests", type: "boolean", description: "If false, the system disables incoming AirPlay requests.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowAirPrint", type: "boolean", description: "If false, the system disables AirPrint.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowAirPrintCredentialsStorage", type: "boolean", description: "If false, the system disables Keychain storage of user name and password for AirPrint.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowAirPrintiBeaconDiscovery", type: "boolean", description: "If false, the system disables iBeacon discovery of AirPrint printers.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowAppCellularDataModification", type: "boolean", description: "If false, the system disables changing settings for cellular data usage for apps.", defaultValue: T, recommendation: "Disable — prevents kids from changing data settings.", overridable: false },
  { key: "allowAppClips", type: "boolean", description: "If false, the system prevents a user from adding any App Clips, and removes any existing App Clips on the device.", defaultValue: T, recommendation: "Disable — App Clips bypass app whitelisting.", overridable: false },
  { key: "allowAppInstallation", type: "boolean", description: "If false, the system disables the App Store and removes its icon from the Home Screen. Users are unable to install or update their apps.", defaultValue: T, recommendation: "Disable — only allow apps via the profile whitelist.", overridable: false },
  { key: "allowApplePersonalizedAdvertising", type: "boolean", description: "If false, the system limits Apple personalized advertising.", defaultValue: T, recommendation: "Disable — limits ad tracking.", overridable: false },
  { key: "allowAppRemoval", type: "boolean", description: "If false, the system disables removal of apps from an iOS device.", defaultValue: T, recommendation: "Disable — prevents kids from deleting managed apps.", overridable: false },
  { key: "allowAppsToBeHidden", type: "boolean", description: "If false, disables the ability for the user to hide apps.", defaultValue: T, recommendation: "Disable — keeps all apps visible.", overridable: false },
  { key: "allowAppsToBeLocked", type: "boolean", description: "If false, disables the ability for the user to lock apps.", defaultValue: T, recommendation: "Disable — prevents kids from locking apps.", overridable: false },
  { key: "allowAssistant", type: "boolean", description: "If false, the system disables Siri.", defaultValue: T, recommendation: "Leave at default unless Siri is a concern.", overridable: false },
  { key: "allowAssistantUserGeneratedContent", type: "boolean", description: "If false, the system prevents Siri from querying user-generated content from the web.", defaultValue: T, recommendation: "Disable — prevents Siri from accessing web content.", overridable: false },
  { key: "allowAssistantWhileLocked", type: "boolean", description: "If false, the system disables Siri when the device is locked.", defaultValue: T, recommendation: "Disable — prevents Siri use from lock screen.", overridable: false },
  { key: "allowAutoCorrection", type: "boolean", description: "If false, the system disables keyboard autocorrection.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowAutoDim", type: "boolean", description: "If false, disables auto dim on iPads with OLED displays.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowAutomaticAppDownloads", type: "boolean", description: "If false, the system prevents automatic downloading of apps purchased on other devices.", defaultValue: T, recommendation: "Disable — prevents unwanted app installs.", overridable: false },
  { key: "allowAutomaticScreenSaver", type: "boolean", description: "If false, the system disables Apple TV's automatic screen saver.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowAutoUnlock", type: "boolean", description: "If false, the system disallows auto unlock.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowBluetoothModification", type: "boolean", description: "If false, the system prevents modification of Bluetooth settings.", defaultValue: T, recommendation: "Disable — prevents pairing unknown devices.", overridable: false },
  { key: "allowBluetoothSharingModification", type: "boolean", description: "If false, the system prevents modifying Bluetooth settings in System Settings.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowBookstore", type: "boolean", description: "If false, the system removes the Book Store tab from the Books app.", defaultValue: T, recommendation: "Disable — prevents browsing/purchasing books.", overridable: false },
  { key: "allowBookstoreErotica", type: "boolean", description: "If false, the system prevents the user from downloading Apple Books media tagged as erotica.", defaultValue: T, recommendation: "Disable — blocks explicit content.", overridable: false },
  { key: "allowCallRecording", type: "boolean", description: "If false, disables call recording.", defaultValue: T, recommendation: "Disable.", overridable: false },
  { key: "allowCamera", type: "boolean", description: "If false, the system disables the camera and removes its icon from the Home Screen.", defaultValue: T, recommendation: "Leave at default unless camera access is a concern.", overridable: false },
  { key: "allowCellularPlanModification", type: "boolean", description: "If false, the system prevents users from changing settings related to their cellular plan.", defaultValue: T, recommendation: "Disable — prevents cellular plan changes.", overridable: false },
  { key: "allowChat", type: "boolean", description: "If false, the system disables the use of iMessage with supervised devices.", defaultValue: T, recommendation: "Disable for younger children; leave for older.", overridable: true },
  { key: "allowCloudAddressBook", type: "boolean", description: "If false, the system disables iCloud Contacts services.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowCloudBackup", type: "boolean", description: "If false, the system disables backing up the device to iCloud.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowCloudBookmarks", type: "boolean", description: "If false, the system disables iCloud Bookmark sync.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowCloudCalendar", type: "boolean", description: "If false, the system disables iCloud Calendar services.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowCloudDesktopAndDocuments", type: "boolean", description: "If false, the system disables iCloud Desktop and Document services.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowCloudDocumentSync", type: "boolean", description: "If false, the system disables document and key-value syncing to iCloud.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowCloudFreeform", type: "boolean", description: "If false, the system disallows iCloud Freeform services.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowCloudKeychainSync", type: "boolean", description: "If false, the system disables iCloud Keychain synchronization.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowCloudMail", type: "boolean", description: "If false, the system disables iCloud Mail services.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowCloudNotes", type: "boolean", description: "If false, the system disables iCloud Notes services.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowCloudPhotoLibrary", type: "boolean", description: "If false, the system disables iCloud Photo Library.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowCloudPrivateRelay", type: "boolean", description: "If false, the system disables iCloud Private Relay.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowCloudReminders", type: "boolean", description: "If false, the system disables iCloud Reminder services.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowContentCaching", type: "boolean", description: "If false, the system disables content caching.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowContinuousPathKeyboard", type: "boolean", description: "If false, the system disables QuickPath keyboard.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowDefaultBrowserModification", type: "boolean", description: "If false, disables default browser preference modification.", defaultValue: T, recommendation: "Disable — prevents changing the default browser.", overridable: false },
  { key: "allowDefaultCallingAppModification", type: "boolean", description: "If false, disables default calling app preference modification.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowDefaultMessagingAppModification", type: "boolean", description: "If false, disables default messaging app preference modification.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowDefinitionLookup", type: "boolean", description: "If false, the system disables definition lookup.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowDeviceNameModification", type: "boolean", description: "If false, the system prevents the user from changing the device name.", defaultValue: T, recommendation: "Disable — prevents device name changes.", overridable: false },
  { key: "allowDeviceSleep", type: "boolean", description: "If false, the system prevents the device from automatically sleeping.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowDiagnosticSubmission", type: "boolean", description: "If false, the system prevents the device from automatically submitting diagnostic reports to Apple.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowDiagnosticSubmissionModification", type: "boolean", description: "If false, the system disables changing the diagnostic submission and app analytics settings.", defaultValue: T, recommendation: "Disable — prevents changing diagnostic settings.", overridable: false },
  { key: "allowDictation", type: "boolean", description: "If false, the system disallows dictation input.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowEnablingRestrictions", type: "boolean", description: "If false, the system disables the Enable ScreenTime option in Settings.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowEnterpriseAppTrust", type: "boolean", description: "If false, the system removes the Trust Enterprise Developer button in Settings.", defaultValue: T, recommendation: "Disable — prevents sideloading enterprise apps.", overridable: false },
  { key: "allowEnterpriseBookBackup", type: "boolean", description: "If false, the system disables backup of Enterprise books.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowEnterpriseBookMetadataSync", type: "boolean", description: "If false, the system disables sync of Enterprise books, notes, and highlights.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowEraseContentAndSettings", type: "boolean", description: "If false, the system disables the Erase All Content and Settings option.", defaultValue: T, recommendation: "Disable — prevents kids from wiping the device.", overridable: false },
  { key: "allowESIMModification", type: "boolean", description: "If false, the system disables modifications of eSIMs.", defaultValue: T, recommendation: "Disable — prevents eSIM changes.", overridable: false },
  { key: "allowESIMOutgoingTransfers", type: "boolean", description: "If false, prevents the transfer of an eSIM to a different device.", defaultValue: T, recommendation: "Disable.", overridable: false },
  { key: "allowExplicitContent", type: "boolean", description: "If false, the system hides explicit music or video content purchased from the iTunes Store.", defaultValue: T, recommendation: "Disable — blocks explicit content.", overridable: false },
  { key: "allowExternalIntelligenceIntegrations", type: "boolean", description: "If false, disables the use of external, cloud-based intelligence services with Siri.", defaultValue: T, recommendation: "Disable.", overridable: false },
  { key: "allowExternalIntelligenceIntegrationsSignIn", type: "boolean", description: "If false, forces external intelligence providers into anonymous mode.", defaultValue: T, recommendation: "Disable.", overridable: false },
  { key: "allowFileSharingModification", type: "boolean", description: "If false, the system prevents modifying File Sharing setting in System Settings.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowFilesNetworkDriveAccess", type: "boolean", description: "If false, the system prevents connecting to network drives in the Files app.", defaultValue: T, recommendation: "Disable — prevents accessing network drives.", overridable: false },
  { key: "allowFilesUSBDriveAccess", type: "boolean", description: "If false, the system prevents connecting to any connected USB devices in the Files app.", defaultValue: T, recommendation: "Disable — prevents USB drive access.", overridable: false },
  { key: "allowFindMyDevice", type: "boolean", description: "If false, the system disables Find My Device.", defaultValue: T, recommendation: "Leave at default — Find My is useful for kids' devices.", overridable: false },
  { key: "allowFindMyFriends", type: "boolean", description: "If false, the system disables Find My Friends.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowFindMyFriendsModification", type: "boolean", description: "If false, the system disables changes to Find My Friends.", defaultValue: T, recommendation: "Disable — prevents kids from disabling location sharing.", overridable: false },
  { key: "allowFingerprintForUnlock", type: "boolean", description: "If false, the system prevents Touch ID, Face ID, or Optic ID from unlocking a device.", defaultValue: T, recommendation: "Disable — parents use passcode only, no biometrics.", overridable: false },
  { key: "allowFingerprintModification", type: "boolean", description: "If false, the system prevents the user from modifying Touch ID or Face ID.", defaultValue: T, recommendation: "Disable — prevents adding new biometrics.", overridable: false },
  { key: "allowGameCenter", type: "boolean", description: "If false, the system disables Game Center and removes its icon.", defaultValue: T, recommendation: "Disable for younger children; leave for older.", overridable: true },
  { key: "allowGenmoji", type: "boolean", description: "If false, prohibits creating new Genmoji.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowGlobalBackgroundFetchWhenRoaming", type: "boolean", description: "If false, the system disables global background fetch activity when roaming.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowHostPairing", type: "boolean", description: "If false, the system disables host pairing with the exception of the supervision host.", defaultValue: T, recommendation: "Disable — prevents pairing with untrusted computers.", overridable: false },
  { key: "allowImagePlayground", type: "boolean", description: "If false, prohibits the use of image generation.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowImageWand", type: "boolean", description: "If false, prohibits the use of Image Wand.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowInAppPurchases", type: "boolean", description: "If false, the system prohibits in-app purchasing.", defaultValue: T, recommendation: "Disable — prevents unwanted purchases.", overridable: false },
  { key: "allowInternetSharingModification", type: "boolean", description: "If false, the system prevents modifying the Internet Sharing setting.", defaultValue: T, recommendation: "Disable — prevents enabling hotspot.", overridable: false },
  { key: "allowiPhoneMirroring", type: "boolean", description: "If false, prohibits the use of iPhone Mirroring.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowiPhoneWidgetsOnMac", type: "boolean", description: "If false, the system disallows iPhone widgets on a Mac.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowiTunes", type: "boolean", description: "If false, the system disables the iTunes Music Store and removes its icon.", defaultValue: T, recommendation: "Disable — prevents media purchases.", overridable: false },
  { key: "allowiTunesFileSharing", type: "boolean", description: "If false, the system disables iTunes file sharing services.", defaultValue: T, recommendation: "Disable — prevents file sharing via iTunes.", overridable: false },
  { key: "allowKeyboardShortcuts", type: "boolean", description: "If false, the system disables keyboard shortcuts.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowLiveVoicemail", type: "boolean", description: "If false, the system disables live voicemail.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowLocalUserCreation", type: "boolean", description: "If false, the system prevents creating users in System Settings.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowLockScreenControlCenter", type: "boolean", description: "If false, the system prevents Control Center from appearing on the Lock Screen.", defaultValue: T, recommendation: "Disable — prevents settings changes from lock screen.", overridable: false },
  { key: "allowLockScreenNotificationsView", type: "boolean", description: "If false, the system disables the Notifications history view on the Lock Screen.", defaultValue: T, recommendation: "Disable for younger children — hides notification history.", overridable: false },
  { key: "allowLockScreenTodayView", type: "boolean", description: "If false, the system disables the Today view in Notification Center on the Lock Screen.", defaultValue: T, recommendation: "Disable — reduces lock screen distractions.", overridable: false },
  { key: "allowMailPrivacyProtection", type: "boolean", description: "If false, the system disables Mail Privacy Protection.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowMailSmartReplies", type: "boolean", description: "If false, disables smart replies in Mail.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowMailSummary", type: "boolean", description: "If false, disables the ability to create summaries of email messages manually.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowManagedAppsCloudSync", type: "boolean", description: "If false, the system prevents managed apps from using iCloud sync.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowManagedToWriteUnmanagedContacts", type: "boolean", description: "If true, the system allows managed apps to write contacts to unmanaged accounts.", defaultValue: F, recommendation: "Leave at default.", overridable: false },
  { key: "allowMarketplaceAppInstallation", type: "boolean", description: "If false, the system prevents installation of alternative marketplace apps from the web.", defaultValue: T, recommendation: "Disable — prevents sideloading from alternative app stores.", overridable: false },
  { key: "allowMediaSharingModification", type: "boolean", description: "If false, prevents modification of Media Sharing settings.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowMultiplayerGaming", type: "boolean", description: "If false, the system prohibits multiplayer gaming.", defaultValue: T, recommendation: "Disable for younger children — prevents online interaction.", overridable: true },
  { key: "allowMusicService", type: "boolean", description: "If false, the system disables the Music service.", defaultValue: T, recommendation: "Leave at default unless Apple Music is a concern.", overridable: false },
  { key: "allowNews", type: "boolean", description: "If false, the system disables News.", defaultValue: T, recommendation: "Disable for younger children.", overridable: false },
  { key: "allowNFC", type: "boolean", description: "If false, the system disables NFC.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowNotesTranscription", type: "boolean", description: "If false, disables transcription in Notes.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowNotesTranscriptionSummary", type: "boolean", description: "If false, disables transcription summarization in Notes.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowNotificationsModification", type: "boolean", description: "If false, the system disables modification of notification settings.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowOpenFromManagedToUnmanaged", type: "boolean", description: "If false, documents in managed apps and accounts open only in other managed apps and accounts.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowOpenFromUnmanagedToManaged", type: "boolean", description: "If false, documents in unmanaged apps and accounts open only in other unmanaged apps and accounts.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowOTAPKIUpdates", type: "boolean", description: "If false, the system disables over-the-air PKI updates.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowPairedWatch", type: "boolean", description: "If false, the system disables pairing with an Apple Watch.", defaultValue: T, recommendation: "Disable — kids shouldn't have access to other devices.", overridable: false },
  { key: "allowPassbookWhileLocked", type: "boolean", description: "If false, the system hides Passbook notifications from the Lock Screen.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowPasscodeModification", type: "boolean", description: "If false, the system prevents adding, changing, or removing the passcode.", defaultValue: T, recommendation: "Disable — prevents kids from removing the passcode.", overridable: false },
  { key: "allowPasswordAutoFill", type: "boolean", description: "If false, the system disables AutoFill Passwords, saved password prompts, and strong password suggestions.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowPasswordProximityRequests", type: "boolean", description: "If false, the system disables requesting passwords from nearby devices.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowPasswordSharing", type: "boolean", description: "If false, the system disables sharing passwords via AirDrop or the Passwords app.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowPersonalHotspotModification", type: "boolean", description: "If false, the system disables modifications of the personal hotspot setting.", defaultValue: T, recommendation: "Disable — prevents enabling hotspot.", overridable: false },
  { key: "allowPersonalizedHandwritingResults", type: "boolean", description: "If false, prevents the system from generating text in the user's handwriting.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowPhotoStream", type: "boolean", description: "If false, the system disables Photo Stream.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowPodcasts", type: "boolean", description: "If false, the system disables podcasts.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowPredictiveKeyboard", type: "boolean", description: "If false, the system disables predictive keyboards.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowPrinterSharingModification", type: "boolean", description: "If false, the system prevents modifying Printer Sharing settings.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowProximitySetupToNewDevice", type: "boolean", description: "If false, disables the prompt to set up new devices that are nearby.", defaultValue: T, recommendation: "Disable — prevents data transfer to new devices.", overridable: false },
  { key: "allowRadioService", type: "boolean", description: "If false, the system disables Apple Music Radio.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowRCSMessaging", type: "boolean", description: "If false, prevents the use of RCS messaging.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowRemoteAppleEventsModification", type: "boolean", description: "If false, the system prevents modifying Remote Apple Events Sharing settings.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowRemoteAppPairing", type: "boolean", description: "If false, the system disables pairing Apple TV for use with the Control Center widget.", defaultValue: T, recommendation: "Disable — kids shouldn't have access to other devices.", overridable: false },
  { key: "allowRemoteScreenObservation", type: "boolean", description: "If false, the system disables remote screen observation by the Classroom app.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowRosettaUsageAwareness", type: "boolean", description: "If false, disables Rosetta usage awareness.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowSafari", type: "boolean", description: "If false, the system disables the Safari web browser app and removes its icon.", defaultValue: T, recommendation: "Leave at default — the web filter payload handles Safari restrictions.", overridable: false },
  { key: "allowSafariHistoryClearing", type: "boolean", description: "If false, the system disables the ability to clear browsing history in Safari.", defaultValue: T, recommendation: "Disable — preserves browsing history for review.", overridable: false },
  { key: "allowSafariPrivateBrowsing", type: "boolean", description: "If false, the system disables the ability to use private browsing in Safari.", defaultValue: T, recommendation: "Disable — prevents incognito browsing.", overridable: false },
  { key: "allowSafariSummary", type: "boolean", description: "If false, the system disables the ability to summarize content in Safari.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowSatelliteConnection", type: "boolean", description: "If false, the system prohibits the connection to and use of satellite services.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowScreenShot", type: "boolean", description: "If false, the system disables saving a screenshot and capturing a screen recording.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowSharedDeviceTemporarySession", type: "boolean", description: "If false, the system makes temporary sessions unavailable on Shared iPad.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowSharedStream", type: "boolean", description: "If false, the system disables Shared Photo Stream.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowSpellCheck", type: "boolean", description: "If false, the system disables the keyboard spell checker.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowSpotlightInternetResults", type: "boolean", description: "If false, the system disables Spotlight Internet search results in Siri Suggestions.", defaultValue: T, recommendation: "Disable — prevents web search results.", overridable: false },
  { key: "allowStartupDiskModification", type: "boolean", description: "If false, the system prevents modification of Startup Disk settings.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowSystemAppRemoval", type: "boolean", description: "If false, the system disables the removal of system apps from the device.", defaultValue: T, recommendation: "Disable — prevents deleting system apps.", overridable: false },
  { key: "allowTimeMachineBackup", type: "boolean", description: "If false, the system prevents modification of Time Machine settings.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowUIAppInstallation", type: "boolean", description: "If false, the system disables the App Store and removes its icon. Users can still install apps locally or via marketplace apps.", defaultValue: T, recommendation: "Disable — hides the App Store UI.", overridable: false },
  { key: "allowUIConfigurationProfileInstallation", type: "boolean", description: "If false, the system prohibits the user from installing configuration profiles and certificates interactively.", defaultValue: T, recommendation: "Leave at default — profile installation from the web is part of the system design.", overridable: false },
  { key: "allowUniversalControl", type: "boolean", description: "If false, the system disables Universal Control.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowUnmanagedToReadManagedContacts", type: "boolean", description: "If true, the system allows unmanaged apps to read from managed contacts accounts.", defaultValue: F, recommendation: "Leave at default.", overridable: false },
  { key: "allowUnpairedExternalBootToRecovery", type: "boolean", description: "If true, the system allows unpaired devices to boot devices into recovery.", defaultValue: F, recommendation: "Leave at default.", overridable: false },
  { key: "allowUntrustedTLSPrompt", type: "boolean", description: "If false, the system automatically rejects untrusted HTTPS certificates without prompting the user.", defaultValue: T, recommendation: "Disable — blocks untrusted certificates silently.", overridable: false },
  { key: "allowUSBRestrictedMode", type: "boolean", description: "If false, the system allows iOS devices to always connect to USB accessories while locked.", defaultValue: T, recommendation: "Leave at default — USB restricted mode is a security feature.", overridable: false },
  { key: "allowVideoConferencing", type: "boolean", description: "If false, the system hides the FaceTime app.", defaultValue: T, recommendation: "Disable for younger children; leave for older.", overridable: true },
  { key: "allowVideoConferencingRemoteControl", type: "boolean", description: "If false, disables the ability for a remote FaceTime session to request control of the device.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowVisualIntelligenceSummary", type: "boolean", description: "If false, the system disables visual intelligence summarization.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowVoiceDialing", type: "boolean", description: "If false, the system disables voice dialing if the device is locked with a passcode.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "allowVPNCreation", type: "boolean", description: "If false, the system allows only managed apps to create VPN configurations.", defaultValue: T, recommendation: "Disable — prevents kids from creating VPNs.", overridable: false },
  { key: "allowWallpaperModification", type: "boolean", description: "If false, the system prevents changing the wallpaper.", defaultValue: T, recommendation: "Leave at default — wallpaper customization is a planned feature.", overridable: false },
  { key: "allowWebDistributionAppInstallation", type: "boolean", description: "If false, the device prevents installation of apps directly from the web.", defaultValue: T, recommendation: "Disable — prevents web-based app installs.", overridable: false },
  { key: "allowWritingTools", type: "boolean", description: "If false, disables Apple Intelligence writing tools.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  // ── force* restrictions (default false) ──────────────────────
  { key: "forceAirDropUnmanaged", type: "boolean", description: "If true, the system considers AirDrop to be an unmanaged drop target.", defaultValue: F, recommendation: "Leave at default.", overridable: false },
  { key: "forceAirPlayIncomingRequestsPairingPassword", type: "boolean", description: "If true, the system forces all devices sending AirPlay requests to this device to use a pairing password.", defaultValue: F, recommendation: "Leave at default.", overridable: false },
  { key: "forceAirPlayOutgoingRequestsPairingPassword", type: "boolean", description: "If true, the system forces all devices receiving AirPlay requests from this device to use a pairing password.", defaultValue: F, recommendation: "Leave at default.", overridable: false },
  { key: "forceAirPrintTrustedTLSRequirement", type: "boolean", description: "If true, the system requires trusted certificates for TLS printing communication.", defaultValue: F, recommendation: "Leave at default.", overridable: false },
  { key: "forceAssistantProfanityFilter", type: "boolean", description: "If true, the system forces the use of the profanity filter for Siri and dictation.", defaultValue: F, recommendation: "Enable — filters profanity in Siri.", overridable: false },
  { key: "forceAuthenticationBeforeAutoFill", type: "boolean", description: "If true, the user needs to authenticate before the system can autofill passwords or credit card information.", defaultValue: F, recommendation: "Enable — requires Face ID/Touch ID before AutoFill.", overridable: false },
  { key: "forceAutomaticDateAndTime", type: "boolean", description: "If true, the system enables the Set Automatically feature in Date & Time and the user can't disable it.", defaultValue: F, recommendation: "Enable — prevents kids from changing date/time.", overridable: false },
  { key: "forceBypassScreenCaptureAlert", type: "boolean", description: "If true, then the system bypasses the presentation of a screen capture alert.", defaultValue: F, recommendation: "Leave at default.", overridable: false },
  { key: "forceClassroomAutomaticallyJoinClasses", type: "boolean", description: "If true, the system automatically gives permission to the teacher's requests without prompting the student.", defaultValue: F, recommendation: "Leave at default.", overridable: false },
  { key: "forceClassroomRequestPermissionToLeaveClasses", type: "boolean", description: "If true, a student enrolled in an unmanaged course through Classroom needs to request permission to leave.", defaultValue: F, recommendation: "Leave at default.", overridable: false },
  { key: "forceClassroomUnpromptedAppAndDeviceLock", type: "boolean", description: "If true, the system allows the teacher to lock apps or the device without prompting the student.", defaultValue: F, recommendation: "Leave at default.", overridable: false },
  { key: "forceClassroomUnpromptedScreenObservation", type: "boolean", description: "If true, a student in a managed Classroom course automatically gives permission to observe the screen.", defaultValue: F, recommendation: "Leave at default.", overridable: false },
  { key: "forceEncryptedBackup", type: "boolean", description: "If true, the system encrypts all backups.", defaultValue: F, recommendation: "Enable — ensures backups are encrypted.", overridable: false },
  { key: "forceITunesStorePasswordEntry", type: "boolean", description: "If true, the system forces the user to enter their iTunes password for each transaction.", defaultValue: F, recommendation: "Enable — requires password for every purchase.", overridable: false },
  { key: "forceLimitAdTracking", type: "boolean", description: "If true, the system limits ad tracking and disables app tracking.", defaultValue: F, recommendation: "Enable — limits ad tracking.", overridable: false },
  { key: "forceOnDeviceOnlyDictation", type: "boolean", description: "If true, the system disables connections to Siri servers for dictation.", defaultValue: F, recommendation: "Enable — keeps dictation on-device.", overridable: false },
  { key: "forceOnDeviceOnlyTranslation", type: "boolean", description: "If true, the device can't connect to Siri servers for translation.", defaultValue: F, recommendation: "Enable — keeps translation on-device.", overridable: false },
  { key: "forcePreserveESIMOnErase", type: "boolean", description: "If true, the system preserves eSIM when it erases the device.", defaultValue: F, recommendation: "Enable — preserves eSIM on accidental wipe.", overridable: false },
  { key: "forceWatchWristDetection", type: "boolean", description: "If true, the system forces a paired Apple Watch to use Wrist Detection.", defaultValue: F, recommendation: "Leave at default.", overridable: false },
  { key: "forceWiFiPowerOn", type: "boolean", description: "If true, the system prevents turning off Wi-Fi in Settings or Control Center.", defaultValue: F, recommendation: "Enable — ensures kids stay connected and trackable.", overridable: false },
  { key: "forceWiFiToAllowedNetworksOnly", type: "boolean", description: "If true, the system limits the device to only join Wi-Fi networks set up through a configuration profile.", defaultValue: F, recommendation: "Enable — restricts Wi-Fi to known networks.", overridable: false },
  { key: "forceWiFiWhitelisting", type: "boolean", description: "Deprecated. Use forceWiFiToAllowedNetworksOnly instead.", defaultValue: F, recommendation: "Use forceWiFiToAllowedNetworksOnly instead.", overridable: false },
  // ── Non-boolean restrictions ──────────────────────────────────
  { key: "enforcedFingerprintTimeout", type: "integer", description: "The value, in seconds, after which the fingerprint unlock requires a password to authenticate.", defaultValue: 172800, recommendation: "Leave at default (48 hours).", overridable: false },
  { key: "ratingApps", type: "integer", description: "The maximum level of app content allowed on the device. 1000=All, 300=12+, 600=17+, 0=None.", defaultValue: 1000, recommendation: "Set to age-appropriate level (e.g. 300 for 12+).", overridable: false },
  { key: "ratingMovies", type: "integer", description: "The maximum level of movie content allowed. 1000=All, 400=R, 300=PG-13, 200=PG, 100=G, 0=None.", defaultValue: 1000, recommendation: "Set to age-appropriate level.", overridable: false },
  { key: "ratingRegion", type: "string", description: "The two-letter key that profile tools use to display the proper ratings for the given region.", defaultValue: null, recommendation: "Set to your region (e.g. 'us').", overridable: false },
  { key: "ratingTVShows", type: "integer", description: "The maximum level of TV content allowed. 1000=All, 500=TV-14, 400=TV-PG, 200=TV-Y7, 100=TV-Y, 0=None.", defaultValue: 1000, recommendation: "Set to age-appropriate level.", overridable: false },
  { key: "safariAcceptCookies", type: "real", description: "Defines the conditions under which the device accepts cookies. 0=block all, 1/1.5=cross-site tracking only, 2=default.", defaultValue: 2, recommendation: "Set to 0 to block all cookies, or 1 for cross-site only.", overridable: false },
  { key: "safariAllowAutoFill", type: "boolean", description: "If false, the system disables Safari AutoFill for passwords, contact info, and credit cards.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "safariAllowJavaScript", type: "boolean", description: "If false, Safari doesn't execute JavaScript.", defaultValue: T, recommendation: "Leave at default — many sites need JS.", overridable: false },
  { key: "safariAllowPopups", type: "boolean", description: "If false, Safari doesn't allow pop-up windows.", defaultValue: T, recommendation: "Leave at default.", overridable: false },
  { key: "safariForceFraudWarning", type: "boolean", description: "If true, the system enables Safari fraud warning.", defaultValue: F, recommendation: "Enable — shows fraud warnings.", overridable: false },
];

// ── Lookup map ─────────────────────────────────────────────────────

const CATALOG_MAP: Record<string, RestrictionMeta> = Object.fromEntries(
  RESTRICTION_CATALOG.map((r) => [r.key, r]),
);

/**
 * Returns the catalog metadata for a restriction key, or null if the key
 * is not in the catalog (unknown/custom restriction).
 */
export function getRestrictionMeta(key: string): RestrictionMeta | null {
  return CATALOG_MAP[key] ?? null;
}

/**
 * Returns true if the restriction's value matches its documented default.
 * For unknown restrictions (not in catalog), always returns false — we
 * can't know the default, so we include them in the profile.
 */
export function isDefaultValue(key: string, value: boolean | number | string): boolean {
  const meta = CATALOG_MAP[key];
  if (!meta || meta.defaultValue === null) return false;
  // Compare as strings to handle type coercion (e.g. "true" vs true)
  return String(value) === String(meta.defaultValue);
}

/**
 * Filters a list of restrictions, removing any whose value matches the
 * documented default. This keeps profiles minimal — only non-default
 * overrides are included in the generated .mobileconfig.
 */
export function filterNonDefault<T extends { key: string; value: boolean | number | string }>(
  restrictions: T[],
): T[] {
  return restrictions.filter((r) => !isDefaultValue(r.key, r.value));
}

/**
 * Parses the recommendation text to determine the concrete recommended value.
 * Returns null when the recommendation is conditional or vague (e.g.
 * "Set to age-appropriate level") and can't be mapped to a single value.
 *
 * Patterns recognised:
 *   "Disable — ..."        → false  (booleans)
 *   "Enable — ..."         → true   (booleans)
 *   "Leave at default..."  → meta.defaultValue
 *   "Set to <number>..."    → that number (integers/reals)
 *   Everything else        → null
 */
export function getRecommendedValue(meta: RestrictionMeta): boolean | number | string | null {
  const rec = meta.recommendation.trim().toLowerCase();

  if (meta.type === "boolean") {
    if (rec.startsWith("disable")) return false;
    if (rec.startsWith("enable")) return true;
    if (rec.startsWith("leave at default")) return meta.defaultValue;
    // "Use X instead" or conditional — can't determine
    return null;
  }

  // Non-boolean restrictions
  if (rec.startsWith("leave at default")) return meta.defaultValue;

  // "Set to <number> ..." — extract the first number
  const match = rec.match(/set to (\d+(?:\.\d+)?)/);
  if (match) return match[1].includes(".") ? Number(match[1]) : Number(match[1]);

  return null;
}

/**
 * Returns whether the restriction's value matches the recommendation.
 * - "accepted": value matches the recommended value
 * - "ignored": value does not match the recommended value
 * - null: recommendation is conditional/vague — no accept/ignore status
 */
export function recommendationStatus(
  key: string,
  value: boolean | number | string,
): "accepted" | "ignored" | null {
  const meta = CATALOG_MAP[key];
  if (!meta) return null;
  const recommended = getRecommendedValue(meta);
  if (recommended === null) return null;
  return String(value) === String(recommended) ? "accepted" : "ignored";
}

/**
 * A restriction override entry — same shape as Restriction but used in
 * theme/child override lists.
 */
export interface RestrictionOverride {
  key: string;
  value: boolean | number | string;
}

/**
 * Merges global restrictions with theme-level and child-level overrides.
 * Precedence: global → theme → child (child wins).
 *
 * Only restrictions marked `overridable: true` in the catalog are eligible
 * for overriding. Non-overridable restrictions always use the global value.
 *
 * @param global - The global restriction list (from the Restrictions table)
 * @param themeOverrides - Overrides from the applicable age band/theme
 * @param childOverrides - Overrides from the specific child
 * @returns Merged restriction list with overrides applied
 */
export function mergeRestrictions(
  global: { key: string; value: boolean | number | string; type: RestrictionType }[],
  themeOverrides: RestrictionOverride[] = [],
  childOverrides: RestrictionOverride[] = [],
): { key: string; value: boolean | number | string; type: RestrictionType }[] {
  const overrideMap = new Map<string, boolean | number | string>();

  // Apply theme overrides first (lower precedence)
  for (const ov of themeOverrides) {
    const meta = CATALOG_MAP[ov.key];
    if (meta?.overridable) {
      overrideMap.set(ov.key, ov.value);
    }
  }

  // Apply child overrides (higher precedence — wins over theme)
  for (const ov of childOverrides) {
    const meta = CATALOG_MAP[ov.key];
    if (meta?.overridable) {
      overrideMap.set(ov.key, ov.value);
    }
  }

  // Build merged list: global values, with overrides applied
  return global.map((r) => {
    if (overrideMap.has(r.key)) {
      return { ...r, value: overrideMap.get(r.key)! };
    }
    return r;
  });
}
