![atlas-logo](https://github.com/user-attachments/assets/612ba427-917f-4930-a786-1bda7c472e47)

# Atlas Explorer

## Features:

* Categorizable folders
* Notes (markdown supported)
* Tags
* Checksum monitoring
* Generates audit trail as you browse

### UP NEXT:
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
[ ] Make directory layout (columns shown, column sizes) are stored in the dirs table - empty is default view else store entire state

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