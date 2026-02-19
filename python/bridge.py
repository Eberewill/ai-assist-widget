import sys
import json
import atomacos

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
    result = get_active_window_info()
    print(json.dumps(result))
