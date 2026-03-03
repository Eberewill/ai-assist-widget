import sys
import json
import atomacos
import subprocess

def get_selected_text_via_applescript():
    """Try to get selected text using AppleScript from the frontmost application."""
    try:
        # AppleScript to get selected text from the frontmost app
        script = '''
        tell application "System Events"
            set frontApp to name of first application process whose frontmost is true
        end tell
        
        tell application frontApp
            try
                set selectedText to (get selection as string)
                return selectedText
            on error
                return ""
            end try
        end tell
        '''
        
        result = subprocess.run(
            ['osascript', '-e', script],
            capture_output=True,
            text=True,
            timeout=5
        )
        
        if result.returncode == 0:
            text = result.stdout.strip()
            return text if text else None
        return None
    except:
        return None

def get_selected_text_via_accessibility():
    """Try to get selected text using accessibility APIs."""
    try:
        active_app = atomacos.active_application()
        if not active_app:
            return None
        
        # Try to get the focused element
        focused_element = None
        
        # Get the main window
        windows = active_app.windows()
        if not windows:
            return None
        
        main_win = windows[0]
        
        # Try to find the focused element recursively
        def find_focused_element(element, depth=0):
            if depth > 5:
                return None
            
            try:
                # Check if this element has focus
                if hasattr(element, 'AXFocused') and element.AXFocused:
                    return element
                
                # Check children
                if hasattr(element, 'AXChildren'):
                    for child in element.AXChildren:
                        result = find_focused_element(child, depth + 1)
                        if result:
                            return result
            except:
                pass
            
            return None
        
        focused = find_focused_element(main_win)
        
        if focused and hasattr(focused, 'AXSelectedText'):
            return focused.AXSelectedText
        
        # Try getting AXValue as fallback
        if focused and hasattr(focused, 'AXValue'):
            return focused.AXValue
        
        return None
    except:
        return None

def get_selected_text():
    """Get currently selected/highlighted text from the active application."""
    # Try AppleScript first (works well in browsers, text editors)
    text = get_selected_text_via_applescript()
    if text:
        return {"success": True, "text": text, "source": "applescript"}
    
    # Fallback to accessibility API
    text = get_selected_text_via_accessibility()
    if text:
        return {"success": True, "text": text, "source": "accessibility"}
    
    return {"success": False, "text": "", "error": "No text selected or app doesn't support selection reading"}

def get_active_window_info():
    try:
        # Get the active application
        active_app = atomacos.active_application()
        if not active_app:
            return {"error": "No active application found"}

        # Get the main window of the active app
        windows = active_app.windows()
        if not windows:
            return {"app": active_app.bundle_id, "error": "No windows found"}
        
        main_win = windows[0]
        
        # Extract basic info
        info = {
            "app_name": active_app.name,
            "bundle_id": active_app.bundle_id,
            "window_title": main_win.AXTitle,
            "elements": []
        }

        # Recursively find interesting elements (buttons, text fields, tables)
        def extract_elements(element, depth=0):
            if depth > 3: # Keep it shallow for performance
                return

            try:
                role = element.AXRole
                if role in ["AXButton", "AXTextField", "AXTextArea", "AXStaticText", "AXLink"]:
                    info["elements"].append({
                        "role": role,
                        "title": element.AXTitle if hasattr(element, "AXTitle") else "",
                        "value": element.AXValue if hasattr(element, "AXValue") else "",
                        "description": element.AXDescription if hasattr(element, "AXDescription") else ""
                    })
                
                # Iterate children
                for child in element.AXChildren:
                    extract_elements(child, depth + 1)
            except:
                pass

        extract_elements(main_win)
        return info

    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    # Check command line arguments
    if len(sys.argv) > 1:
        command = sys.argv[1]
        if command == "get-selected-text":
            result = get_selected_text()
        else:
            result = {"error": f"Unknown command: {command}"}
    else:
        result = get_active_window_info()
    
    print(json.dumps(result))
