![atlas-logo](https://github.com/user-attachments/assets/612ba427-917f-4930-a786-1bda7c472e47)

# Atlas Explorer

I'm making this because I'm just not satisfied with the user experience of File Explorer on Windows. There's some alternatives I've tried, and while they do bring extra features, none of them are appealing enough to ditch the default explorer.exe

This is an app that aims to provide its user maximal utility and transparency into their files. Categories, Tags, and Custom Attributes being the primary driver of utility. 

Philosophy:
* Control over everything. I'd rather be able to shoot myself in the foot than not be able to do something.
* Keep it ussable and useful, the app should make me want to use it.
* Keep it unopinionated, I should be able to use the app as little or as much as I want.
* Keep it fast, 200ms IS noticeable - not that this is a hard limit, but this should inform all design choices.
* Hotkeys are good
* Panels > Tabs - tabs make sense for a web browser, but when Win 11 added them I just found them less convenient than multiple windows.

## Features:

* Categorizable folders
* Notes (markdown supported)
* Tags
* Checksum monitoring
* Generates audit trail as you browse
* Background monitoring rules
* Alerts w/ rules
* Built in terminal
* Customizable context menu actions for launching scripts

### BUGS:
[x] If I set an alert to ANY/ANY - File Added. I get alerts when I first browse a folder. INITIAL events should always be considered a separate thing
[x] Galery View
  [x] the parent (..) folder shows the incorrect styling, seeing current folder style instead of parent style
  [x] Not seeing the toolbar (no search or refresh) on the gallery view (should gallery view have a depth feature?)
[ ] Still getting erroneous title bar when opening a new panel with Ctrl+T
[ ] selectable list attrs need a clear option
[ ] drag-out of app not working (need to hold Alt but still does nothing)
[x] regression, delete key no longer deletes files or folders
[ ] Category changes on directories not working correctly in history events (category in below form doesn't update and the comment should be what says it was an auto-label event)
[ ] Orange badge highlighting for indicating where a favorite will target should revert after navigation is successful
[ ] Panel title path input should not wordwrap but instead overflow hidden

### ROADMAP:
[ ] Update search to inspect more than the filename, primarily tags, attributs and notes. Maybe even contents - configurable per file type? Also, have breadth-first recursion be default behavior
[ ] Search bar should eagerly search the visible fields when changed - submitting the search bar will eventually become a deeper search including invisible columns and contents of text files (contents' names of zip files too?)
[ ] Any way to show metric of path's latency / bandwidth? For a heads up that we are browsing a slow source filesystem
[ ] Browsing zip files - do we want guard against slow locations?
[ ] I think that instead of having checksum be a straight option on categories it should be moved to Alerts and Monitoring where it obeys rules based on category + tags
[ ] un-forced manual assignment should not change the directory category unless there is an auto-assigned category. Currently goes back to Default (or maybe previously assigned category?)
[ ] Make some kind of mark for tags that came from notes (maybe a notes icon that is clickable to open the source notes file?)
[ ] Backup Macros (need to use the app more in practice to think about what this should be like)
[ ] Diffing between files
[ ] Icons for context menu (Do I really want icons on every menu item? seems too cluttered)
[ ] exif GPS data aggregated to map (need to get some photos with GPS data to test)

Gallery View:
[ ] Support coordinate organizing, like the old windows desktops
[ ] Make the thumbnail size changeable and retentive per directory

Grid View:
[ ] I think we did this? TO CHECK - add some more robust method of sizing the columns, would like to add a scalable portion, min/max etc, maybe a percentile text-fit (ie, minimum width fits 90% of elements)
[x] make the grid toolbar command prompt open a popup in the grid context
  [x] add P2 - P(n+1) button to the grid context command prompt
  [ ] add P2 - P(n+1) context menu to the grid context command prompt
[ ] Make it so drag and dropping a file / folder into the command prompt adds the path as text at the cursor
[ ] At Depth > 0 only the base dot and dot dot dirs should be displayed. Currently seeing dot dot dirs from subdirectories.

Tagging modal:
Possible other tab (Tag Summary?), to consider...
[ ] Modal shows a summary of tags and files containing them, with ability to remove files from a tag (respecting notes file archival rule)
[ ] Modal offers the ability to add all items from grid (respecting filter)

TODO Feature:
* Would be nice to have a timestamp on all todos and all comments but there is no good way to maintain continuity if the user edits them in the notes.txt file directly. Perhaps we add some uuid to the file on save but I'm not sure how I feel about this. I Think the least intrusive way would be to have a line with just {uuid} that obeys indenting rules appended after the todo/reminder/item/comment/reply and this would link to timestamp + metadata in the db.

Saved Layouts:
* nothing new

General:
[ ] Show sample icon when creating a category or tag
[ ] When adding Panel 2, it flickers accross the bottom briefly (panels 3 and 4 are okay), please clean this up - ideally it should just appear in the correct position (maybe animate?)
[ ] CHECK IF THIS IS IN THE DOCS! - Make Notes and TODOs support screenshots, uploading automatically to notes_files when pasted in (like github) - then if they are in a TODO, to save space just have a link that opens the photo, and a tooltip like this one (https://w2ui.com/web/demos/#/tooltip/8)
[ ] TODO modal, refine how CTRL+Enter works (currently seems to cancel edits?)
[ ] Make a setting on Categories for LOCAL FAVORITES to inherit down to subdirs
[ ] The auto update feature refers to closing the application as "Restart" - I think this could easily be confused with restarting your PC - instead refer to it as "Close"

Sidebar:
[ ] Change the icon for the local links (shortcuts) to a chain link icon. If the existing icon is for anything it should be to represent items that will open in a modal.
  
Server Version:
* Circle back and check parity later

Hosted (static) Version:
* Circle back and check parity later


Things to Check and/or think about:
* Which changes made in the app trigger alerts - does it make sense? (perhaps option to include?)
* Do we want to support viewing / editing of richer formats? Excel? Word? RTF? PDF?

? What happens if I select remove favorites on a local favorite?
* set category on .. dir not working (no effect) - COULD NOT REPRODUCE
* If adding a tag from the item properties modal, pressing create summons second modal, need to close first or push the create inline
* Create tag modal needs padding on the hex color inputs, currently overlappint with # char
* Seems tags aren't getting a border, they should get the configured outline color as a border
* Seeing a bit of lag after double click - IMPERATIVE that any action that changes the grid will IMMEDIATELY show a loading animation (w/ cancel button?) so the user understands something is going to happen
* LOCAL FAVORITES starts hidden, shows badge of how many links contained

### Off-the-wall stuff for the future:
I think these are decent ideas but should only be considered as add-ins once the app is mature
[ ] Integrate GrapesJS for "dashboards" functionality
  [ ] Ability to define layouts where files are displayed in custom arrangement
  [ ] ^ incl' ability to make "reports" of what files are missing from paths
[ ] Integrate Node-RED for "macros" functionality
  [ ] Automatically perform operations on file scan
  [ ] Customize the right click menu
  [ ] Exposure in Settings menu (to configure user's flows)

### Security notes:
[ ] Need to ensure ALL http requests from the frontend are blocked. We do not need internet functionality on this file explorer
[ ] Do we need to use dompurify (isomorphic-dompurify)? Consider once all the frontend utilities are in place as a sanitization step.
  * <img> tags are safe, need to audit anything that gets appended to the DOM manually
  * markdown disallows html, need to ensure it stays this way