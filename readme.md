![atlas-logo](https://github.com/user-attachments/assets/612ba427-917f-4930-a786-1bda7c472e47)

# Atlas Explorer

I'm making this because I'm just not satisfied with the user experience of File Explorer on Windows. There's some alternatives I've tried and while they do bring extra features, none of them are appealing enough to ditch the default Explorer since it is so baked into the Windows OS.

Philosophy:
* Control over everything. I'd rather be able to shoot myself in the foot than not be able to do something.
* Keep it usable, the app should make me want to use it.
* Keep it fast, 200ms IS noticeable.

## Features:

* Categorizable folders
* Notes (markdown supported)
* Tags
* Checksum monitoring
* Generates audit trail as you browse

### UP NEXT:
* Do Search and Filter next, make it so that if I start typing it will start filtering on name automatically
* CTRL + Enter to do same as double click in grid
[ ] Add a "pin" to Item Properties that prevents it from updating to the selected item (need good icon, maybe lock?)
[ ] Fewer alerts. Currently the "All browser settings saved successfully" alert is annoying, things like this should just show some text stating the same, alerts should be reserved for errors only.

[x] Landing page is an item summary for the item selected in the grid
  [x] Currently locked to panel 1 - make it so it obeys the panel with focus - does nothing if landing page is selected - maybe does if file editor selected?
[ ] Heighten the grid text wrappers, "g" for example is getting cut off at the bottom
[ ] TODOs in notes get aggregated
[ ] Copy as Path in context menu
[ ] Fix / figure out what to do with link in markdown (web links open in Electron)
[ ] Context menu cancel with click off (left click)
[ ] Collapsible Sidebar - all the stuff hides, should just show icons
[ ] Dragon Dropping
[ ] Make New Folder + Make New File
[ ] Make directory layout (columns shown, column sizes, depth) retained. I think have default per category would be good but maybe also need

### TO PONDER:
* Should I abandon my "no file edit in panel 1" philosophy?


### TODO:
[ ] Category inheritance (Set rules like "all subdirs get X category" on category definition)
[x] Tags in notes (and monaco autocomplete)
[ ] Passively (no browse required) Watched directories - configurable by category??
[ ] Filetype profiles (icon and editability)
[ ] Autotagging
[ ] Autocategories
[ ] Search!!!
[ ] Auto Backups
[ ] Diffing
[ ] Icons for context menu
[ ] Photo / Media mode - thumbnails and preview pane + exif data
[ ] Use these info boxes for something: https://w2ui.com/web/demos/#/grid/28

### Crazy stuff:
[ ] Integrate GrapesJS for "dashboards" functionality
  [ ] Ability to define layouts where files are displayed in custom arrangement
  [ ] ^ incl' ability to make "reports" of what files are missing from paths
[ ] Integrate Node-RED for "macros" functionality
  [ ] Automatically perform operations on file scan
  [ ] Customize the right click menu
  [ ] Exposure in Settings menu